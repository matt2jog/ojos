"""Small localhost job server for the Ojos assistant prototype.

The desktop sends one v1 multipart job. The server keeps its event history in
memory, runs clip analysis in a worker, and exposes replayable SSE on loopback.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import re
import shutil
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import parse_qs, urlsplit
from uuid import UUID, uuid4

from .baseline import BaselineAnalyzer
from .gemini import ProviderError
from .media import Clip, load_bundle


MAX_BODY_BYTES = 32 * 1024 * 1024
MAX_JSON_BYTES = 256 * 1024
JOB_TTL_SECONDS = 15 * 60
MAX_ACTIVE_JOBS = 32
SSE_HEARTBEAT_SECONDS = 15.0


class BusyError(ValueError):
    """Raised when the local prototype has reached its bounded admission."""


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _read_json(data: bytes, label: str) -> dict[str, Any]:
    if not data or len(data) > MAX_JSON_BYTES:
        raise ValueError(f"{label} is empty or too large")
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as exc:
        raise ValueError(f"{label} must be UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def _uuid(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a UUID")
    try:
        parsed = UUID(value)
    except (ValueError, AttributeError) as exc:
        raise ValueError(f"{label} must be a UUID") from exc
    return str(parsed)


def _parse_bearer(value: str | None) -> str:
    if not value or not value.startswith("Bearer "):
        return ""
    return value[7:].strip()


def _multipart(body: bytes, content_type: str, required: set[str]) -> dict[str, bytes]:
    """Parse the three simple fields used by the v1 contract.

    This parser is deliberately bounded by the request body limit and does not
    interpret arbitrary nested multipart documents.  It accepts the standard
    CRLF form emitted by the desktop uploader.
    """

    match = re.search(r"(?:^|;)\s*boundary=(?:\"([^\"]+)\"|([^;\s]+))", content_type, re.I)
    if not match:
        raise ValueError("multipart boundary is missing")
    boundary = (match.group(1) or match.group(2)).encode("utf-8")
    if not boundary or len(boundary) > 200:
        raise ValueError("multipart boundary is invalid")

    marker = b"--" + boundary
    fields: dict[str, bytes] = {}
    for raw in body.split(marker)[1:]:
        if raw.startswith(b"--"):
            break
        raw = raw.lstrip(b"\r\n")
        if not raw:
            continue
        header_end = raw.find(b"\r\n\r\n")
        if header_end < 0:
            raise ValueError("multipart part has no header separator")
        header_bytes, value = raw[:header_end], raw[header_end + 4 :]
        if value.endswith(b"\r\n"):
            value = value[:-2]
        headers: dict[str, str] = {}
        for line in header_bytes.split(b"\r\n"):
            if b":" not in line:
                raise ValueError("multipart part has an invalid header")
            key, text = line.split(b":", 1)
            headers[key.decode("ascii").strip().lower()] = text.decode("utf-8", "strict").strip()
        disposition = headers.get("content-disposition", "")
        name_match = re.search(r'(?:^|;)\s*name="([A-Za-z0-9_.-]+)"', disposition)
        if not name_match:
            raise ValueError("multipart part has no field name")
        name = name_match.group(1)
        if name in fields:
            raise ValueError(f"duplicate multipart field {name}")
        if name not in required:
            continue
        fields[name] = value
    if fields.keys() != required:
        missing = sorted(required - fields.keys())
        raise ValueError("missing multipart field(s): " + ", ".join(missing))
    return fields


@dataclass
class _SessionState:
    epoch: int | None = None
    latest_observation_us: int = -1
    latest_job_id: str | None = None
    updated_at: float = field(default_factory=time.monotonic)


@dataclass
class _Job:
    job_id: str
    session_id: str
    event_id: str
    epoch: int
    folder: Path
    clip: Clip
    created_at: float = field(default_factory=time.monotonic)
    state: str = "accepted"
    canceled: bool = False
    terminal: bool = False
    sequence: int = 0
    events: list[tuple[int, str, dict[str, Any]]] = field(default_factory=list)
    condition: threading.Condition = field(default_factory=lambda: threading.Condition(threading.RLock()))

    def append(self, event: str, data: dict[str, Any]) -> None:
        with self.condition:
            if self.terminal and event not in {"job.canceled", "job.expired"}:
                return
            self.sequence += 1
            self.events.append((self.sequence, event, data))
            if event in {"job.result", "job.error", "job.canceled", "job.expired"}:
                self.terminal = True
                self.state = event.removeprefix("job.")
            self.condition.notify_all()

    def close_media(self) -> None:
        shutil.rmtree(self.folder, ignore_errors=True)


class JobServer:
    """State container and worker dispatcher used by the HTTP handler."""

    def __init__(self, analyzer: BaselineAnalyzer | None, token: str, chat=None):
        if not token:
            raise ValueError("token must not be empty")
        self.analyzer = analyzer
        self.token = token
        self.chat = chat
        self.jobs: dict[str, _Job] = {}
        self.keys: dict[tuple[str, str], str] = {}
        self.sessions: dict[str, _SessionState] = {}
        self.lock = threading.RLock()
        self.pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="ojos-job")

    def stop(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)
        with self.lock:
            jobs = list(self.jobs.values())
        for job in jobs:
            job.close_media()

    def _prune_locked(self) -> None:
        cutoff = time.monotonic() - JOB_TTL_SECONDS
        expired = [job_id for job_id, job in self.jobs.items() if job.terminal and job.created_at < cutoff]
        for job_id in expired:
            job = self.jobs.pop(job_id)
            self.keys.pop((job.session_id, job.event_id), None)
            job.close_media()
        active_sessions = {job.session_id for job in self.jobs.values() if not job.terminal}
        for session_id, session in list(self.sessions.items()):
            if session.updated_at < cutoff and session_id not in active_sessions:
                del self.sessions[session_id]

    def create_job(self, fields: Mapping[str, bytes]) -> _Job:
        with self.lock:
            self._prune_locked()
        manifest = _read_json(fields["manifest"], "manifest")
        # media.load_bundle owns the detailed v1 media/gaze validation.
        session_id = _uuid(manifest.get("session_id"), "session_id")
        event_id = _uuid(manifest.get("event_id"), "event_id")
        epoch = manifest.get("capture_epoch")
        if type(epoch) is not int or epoch < 0:
            raise ValueError("capture_epoch must be a nonnegative integer")
        for key in ("clip_start_us", "clip_end_us", "event_start_us", "event_end_us"):
            if type(manifest.get(key)) is not int or manifest[key] < 0:
                raise ValueError(f"{key} must be a nonnegative integer")
        if manifest["clip_end_us"] <= manifest["clip_start_us"]:
            raise ValueError("clip bounds must be a positive interval")
        if manifest["event_end_us"] <= manifest["event_start_us"]:
            raise ValueError("event bounds must be a positive interval")
        # Event bounds are already session-relative on the v1 wire contract.
        observation_us = manifest["event_end_us"]
        key = (session_id, event_id)
        with self.lock:
            existing_id = self.keys.get(key)
            if existing_id:
                existing = self.jobs.get(existing_id)
                if existing:
                    return existing
            if sum(not job.terminal for job in self.jobs.values()) >= MAX_ACTIVE_JOBS:
                raise BusyError("local job capacity is full")

        # Validate the complete bundle before mutating session state.  The clip
        # is retained on the job so the worker does not invoke ffprobe again.
        folder = Path(tempfile.mkdtemp(prefix="ojos-job-"))
        try:
            (folder / "manifest.json").write_bytes(fields["manifest"])
            (folder / "gaze.json").write_bytes(fields["gaze"])
            (folder / "video.mp4").write_bytes(fields["video"])
            clip = load_bundle(folder)
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise
        with self.lock:
            existing_id = self.keys.get(key)
            if existing_id and existing_id in self.jobs:
                shutil.rmtree(folder, ignore_errors=True)
                return self.jobs[existing_id]
            if sum(not job.terminal for job in self.jobs.values()) >= MAX_ACTIVE_JOBS:
                shutil.rmtree(folder, ignore_errors=True)
                raise BusyError("local job capacity is full")
            session = self.sessions.setdefault(session_id, _SessionState())
            if session.epoch is not None and epoch > session.epoch:
                for prior in self.jobs.values():
                    if prior.session_id == session_id and not prior.terminal:
                        prior.canceled = True
                        prior.append("job.canceled", {"schema_version": 1, "reason": "new_capture_epoch"})
                session.latest_observation_us = -1
            elif session.epoch is not None and epoch < session.epoch:
                shutil.rmtree(folder, ignore_errors=True)
                raise ValueError("stale capture_epoch")
            job_id = str(uuid4())
            if observation_us >= session.latest_observation_us:
                session.latest_observation_us = observation_us
                session.latest_job_id = job_id
                session.updated_at = time.monotonic()
            session.epoch = epoch
            job = _Job(job_id, session_id, event_id, epoch, folder, clip)
            self.jobs[job_id] = job
            self.keys[key] = job_id
            job.append("job.status", {"schema_version": 1, "phase": "accepted"})
            self.pool.submit(self._run, job)
            return job

    def _current_locked(self, job: _Job) -> bool:
        if job.terminal:
            return False
        session = self.sessions[job.session_id]
        if session.epoch == job.epoch and session.latest_job_id == job.job_id:
            return True
        job.canceled = True
        job.append("job.canceled", {"schema_version": 1, "reason": "stale_observation"})
        return False

    def _run(self, job: _Job) -> None:
        try:
            with self.lock:
                if not self._current_locked(job):
                    return
                job.append("job.status", {"schema_version": 1, "phase": "analyzing"})
            analysis = self.analyzer.analyze(job.clip).screen_analysis
            questions = analysis["possible_questions"]
            result = {
                "schema_version": 1,
                "status": "answered" if questions else "insufficient_evidence",
                "likely_question": questions[0] if questions else None,
                "answer": analysis["summary"],
                "evidence": analysis["evidence"],
            }
            # Publish both events under the same stale/cancel guard.
            with self.lock:
                if not self._current_locked(job):
                    return
                self.sessions[job.session_id].updated_at = time.monotonic()
                job.append("job.analysis", analysis)
                job.append("job.result", result)
        except Exception as exc:  # provider and validation errors become typed events
            with self.lock:
                if not self._current_locked(job):
                    return
                code = "provider_error" if isinstance(exc, ProviderError) else "analysis_error"
                message = str(exc) if code == "provider_error" else "Could not analyze the clip"
                job.append("job.error", {"schema_version": 1, "code": code, "message": message, "retryable": code == "provider_error"})
        finally:
            job.close_media()

class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "OjosPrototype/0.1"

    @property
    def state(self) -> JobServer:
        return self.server.ojos_state  # type: ignore[attr-defined]

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def _send(self, status: int, data: dict[str, Any]) -> None:
        body = _json_bytes(data)
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        if _parse_bearer(self.headers.get("Authorization")) != self.state.token:
            self._send(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return False
        return True

    def do_POST(self) -> None:
        route = urlsplit(self.path).path
        match = re.fullmatch(r"/v1/chats/([0-9a-f-]+)/messages", route)
        if match and self.state.chat is not None:
            if self._authorized():
                self._chat_turn(match[1])
            return
        if route != "/v1/jobs" or self.state.analyzer is None:
            self._send(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        if not self._authorized():
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if length < 1 or length > MAX_BODY_BYTES:
            self._send(HTTPStatus.REQUEST_ENTITY_TOO_LARGE if length > MAX_BODY_BYTES else HTTPStatus.BAD_REQUEST, {"error": "invalid_content_length"})
            return
        content_type = self.headers.get("Content-Type", "")
        if not content_type.lower().startswith("multipart/form-data"):
            self._send(HTTPStatus.BAD_REQUEST, {"error": "multipart_required"})
            return
        body = self.rfile.read(length)
        try:
            job = self.state.create_job(_multipart(body, content_type, {"manifest", "gaze", "video"}))
        except BusyError as exc:
            self._send(HTTPStatus.TOO_MANY_REQUESTS, {"error": "busy", "message": str(exc)})
            return
        except ValueError as exc:
            self._send(HTTPStatus.BAD_REQUEST, {"error": "invalid_job", "message": str(exc)[:500]})
            return
        self._send(HTTPStatus.ACCEPTED, {"job_id": job.job_id})

    def do_GET(self) -> None:
        target = urlsplit(self.path)
        route = target.path
        service = self.state.chat
        if route == "/v1/chats" and service is not None:
            if self._authorized():
                self._send(HTTPStatus.OK, {"chats": service.store.chats()})
            return
        chat = re.fullmatch(r"/v1/chats/([0-9a-f-]+)/history", route)
        if chat and service is not None:
            if self._authorized():
                try:
                    chat_id = _uuid(chat[1], "chat_id")
                    cursor = parse_qs(target.query, keep_blank_values=True, max_num_fields=8).get("before_seq")
                    before = int(cursor[0]) if cursor else None
                    if before is not None and (len(cursor) != 1 or not 0 < before < 2**63):
                        raise ValueError("Invalid history cursor.")
                except ValueError:
                    self._send(HTTPStatus.BAD_REQUEST, {"error": "invalid_chat_history"})
                    return
                turns = service.store.recent(chat_id, limit=31, before=before)
                matches = service.store.chats(chat_id)
                self._send(HTTPStatus.OK, {
                    "chat": matches[0] if matches else None,
                    "turns": turns[-30:],
                    "older_before_seq": turns[1]["seq"] if len(turns) > 30 else None,
                })
            return
        match = re.fullmatch(r"/v1/jobs/([0-9a-f-]+)/events", route)
        if not match:
            self._send(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        if not self._authorized():
            return
        with self.state.lock:
            self.state._prune_locked()
            job = self.state.jobs.get(match.group(1))
        if not job:
            self._send(HTTPStatus.NOT_FOUND, {"error": "unknown_job"})
            return
        try:
            last_id = int(self.headers.get("Last-Event-ID", "0"))
        except ValueError:
            last_id = 0
        self.send_response(HTTPStatus.OK)
        self.close_connection = True
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self._stream_events(job, max(last_id, 0))

    def _chat_turn(self, raw_id: str) -> None:
        from .adk_chat import ChatBusy, ChatLimit

        service = self.state.chat
        try:
            chat_id = _uuid(raw_id, "chat_id")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 2 * 1024 * 1024:
                raise ValueError("Invalid message size.")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("A chat message must be a JSON object.")
            turn_id = _uuid(payload.get("turn_id"), "turn_id")
            question = payload.get("message")
            screen = payload.get("screen_context", "")
            image = payload.get("jpeg_base64", "")
            if not isinstance(question, str) or not 0 < len(question.strip()) <= 8000:
                raise ValueError("Enter a message up to 8,000 characters.")
            if not isinstance(screen, str) or len(screen) > 6000 or not isinstance(image, str):
                raise ValueError("Invalid screen context.")
            jpeg = base64.b64decode(image, validate=True) if image else None
            if jpeg is not None and (len(jpeg) > 1_400_000 or not jpeg.startswith(b"\xff\xd8\xff")):
                raise ValueError("Invalid screen JPEG.")
            service.reserve(chat_id)
        except ChatBusy as error:
            self._send(HTTPStatus.CONFLICT, {"error": "chat_busy", "message": str(error)})
            return
        except (ValueError, UnicodeDecodeError, binascii.Error, RecursionError) as error:
            self._send(HTTPStatus.BAD_REQUEST, {"error": "invalid_message", "message": str(error)[:300]})
            return

        def emit(event, value):
            self.wfile.write(f"event: {event}\ndata: {_json_bytes(value).decode('utf-8')}\n\n".encode("utf-8"))
            self.wfile.flush()

        try:
            self.send_response(HTTPStatus.OK)
            self.close_connection = True
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            try:
                emit("turn.status", {"text": "Thinking…"})
                answer = asyncio.run(service.run(chat_id, turn_id, question.strip(), screen, jpeg, emit,
                                                 doodles=payload.get("doodles") is True))
                emit("turn.done", {"text": answer, "chat": service.store.chats(chat_id)[0]})
            except (TimeoutError, ChatLimit) as error:
                emit("turn.error", {"message": str(error) or "This turn timed out."})
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception:
                emit("turn.error", {"message": "The assistant could not complete this turn."})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            service.release(chat_id)

    def _stream_events(self, job: _Job, last_id: int) -> None:
        cursor = last_id
        while True:
            with job.condition:
                events = [item for item in job.events if item[0] > cursor]
                terminal = job.terminal
                if not events and not terminal:
                    job.condition.wait(SSE_HEARTBEAT_SECONDS)
                    events = [item for item in job.events if item[0] > cursor]
                    terminal = job.terminal
            try:
                if not events:
                    if terminal:
                        return
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
                    continue
                for sequence, event, data in events:
                    payload = f"id: {sequence}\nevent: {event}\ndata: {_json_bytes(data).decode('utf-8')}\n\n".encode("utf-8")
                    self.wfile.write(payload)
                    self.wfile.flush()
                    cursor = sequence
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                return

    def do_DELETE(self) -> None:
        match = re.fullmatch(r"/v1/jobs/([0-9a-f-]+)", urlsplit(self.path).path)
        if not match:
            self._send(HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        if not self._authorized():
            return
        with self.state.lock:
            job = self.state.jobs.get(match.group(1))
            if job and not job.terminal:
                job.canceled = True
                job.append("job.canceled", {"schema_version": 1, "reason": "client_request"})
                canceled = True
            else:
                canceled = False
        if not job:
            self._send(HTTPStatus.NOT_FOUND, {"error": "unknown_job"})
            return
        job.close_media()
        self._send(HTTPStatus.OK, {"job_id": job.job_id, "canceled": canceled})


class _HTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address: tuple[str, int], state: JobServer):
        super().__init__(address, _Handler)
        self.ojos_state = state

    @property
    def state(self) -> JobServer:
        return self.ojos_state


def build_server(analyzer: BaselineAnalyzer | None, *, token: str, port: int = 8765, chat=None) -> _HTTPServer:
    """Build a testable server.  Call ``server.shutdown()`` to stop it."""

    return _HTTPServer(("127.0.0.1", port), JobServer(analyzer, token, chat))


def serve(analyzer: BaselineAnalyzer | None, *, token: str, port: int = 8766, chat=None) -> None:
    """Serve the local prototype until interrupted."""

    server = build_server(analyzer, token=token, port=port, chat=chat)
    print(f"Ojos assistant listening on http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.state.stop()
        server.server_close()
