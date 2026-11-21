from __future__ import annotations

from http.client import HTTPConnection
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from uuid import uuid4

from .baseline import Analysis, BaselineAnalyzer
from .gemini import Generation
from .server import build_server


class FixtureAnalyzer:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.block_event_id = None

    def analyze(self, clip):
        if clip.event_id == self.block_event_id:
            self.started.set()
            if not self.release.wait(8):
                raise TimeoutError("test timed out")
        return Analysis({"schema_version": 1, **_analysis_at(0)}, {})


def _analysis_at(time_us):
    return {
        "status": "analyzed",
        "suspected_confusion": "The learner may be unsure about list indexing.",
        "possible_questions": ["Which index does this code access?"],
        "summary": "Count the list entries from index zero.",
        "evidence": [{"time_us": time_us, "detail": "A Python list is visible."}],
    }


class FixtureProvider:
    name = "test-provider"

    def generate(self, *, system_instruction, context, video, frames, response_schema):
        self.context = context
        return Generation(_analysis_at(frames[0][0]))


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        workspace = tempfile.TemporaryDirectory(prefix="ojos-server-test-")
        cls.addClassCleanup(workspace.cleanup)
        root = Path(__file__).resolve().parents[2]
        fixture = Path(workspace.name) / "fixture"
        subprocess.run([sys.executable, str(root / "spikes/screen-sync-lab/media/generate.py"), "--output-dir", str(fixture)],
                       check=True, capture_output=True, timeout=30)
        cls.manifest = json.loads((fixture / "manifest.json").read_bytes())
        cls.gaze = (fixture / "gaze.json").read_bytes()
        cls.video = (fixture / "video.mp4").read_bytes()

    def setUp(self):
        self.analyzer = FixtureAnalyzer()
        self.server = build_server(self.analyzer, token="local-test", port=0)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.state.stop)
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.analyzer.release.set)
        self.session_id = str(uuid4())

    def request(self, method, path, body=None, headers=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=8)
        try:
            connection.request(method, path, body, {"Authorization": "Bearer local-test", **(headers or {})})
            response = connection.getresponse()
            return response.status, response.read().decode()
        finally:
            connection.close()

    def submit(self, event_id, offset=0, epoch=0, *, gaze=None, gaze_status=None, expected=202):
        manifest = {**self.manifest, "session_id": self.session_id, "event_id": event_id, "capture_epoch": epoch}
        if gaze_status is not None:
            manifest["gaze_status"] = gaze_status
        for field in ("clip_start_us", "clip_end_us", "event_start_us", "event_end_us"):
            manifest[field] += offset
        fields = (("manifest", json.dumps(manifest).encode()),
                  ("gaze", self.gaze if gaze is None else json.dumps(gaze).encode()), ("video", self.video))
        boundary = f"ojos-test-{uuid4().hex}"
        body = b"".join(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'.encode() + value + b"\r\n"
                        for name, value in fields) + f"--{boundary}--\r\n".encode()
        status, text = self.request("POST", "/v1/jobs", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
        self.assertEqual(status, expected, text)
        return json.loads(text)["job_id"] if expected == 202 else text

    def events(self, job_id, last_id=None):
        headers = {"Last-Event-ID": str(last_id)} if last_id is not None else None
        status, text = self.request("GET", f"/v1/jobs/{job_id}/events", headers=headers)
        self.assertEqual(status, 200, text)
        return [line.removeprefix("event: ") for line in text.splitlines() if line.startswith("event: ")]

    def test_retry_sse_resume_and_reject_stale_epochs(self):
        first, new_epoch = (str(uuid4()) for _ in range(2))
        first_job = self.submit(first)
        self.assertEqual(self.submit(first), first_job)
        self.assertEqual(self.events(first_job), ["job.status", "job.status", "job.analysis", "job.result"])
        self.assertEqual(self.events(first_job, last_id=2), ["job.analysis", "job.result"])
        self.assertEqual(self.events(self.submit(new_epoch, epoch=1))[-1], "job.result")
        self.assertIn("stale capture_epoch", self.submit(str(uuid4()), epoch=0, expected=400))

    def test_saved_chat_list_and_history_pages(self):
        from types import SimpleNamespace
        from .chat_store import ChatStore

        with tempfile.TemporaryDirectory(prefix="ojos-chat-history-") as directory:
            store = ChatStore(Path(directory) / "chat.sqlite3")
            previous, current = str(uuid4()), str(uuid4())
            store.save_turn(previous, "old", "Previous question", "Previous answer", "")
            for n in range(34):
                store.save_turn(current, str(n), f"Question {n}", f"Answer {n}", "", ("Current chat", "Current topic."))
            self.server.state.chat = SimpleNamespace(store=store)
            status, body = self.request("GET", "/v1/chats")
            self.assertEqual(status, 200)
            self.assertEqual([chat["id"] for chat in json.loads(body)["chats"]], [current, previous])
            self.assertEqual(self.request("GET", "/v1/chats", headers={"Authorization": "Bearer invalid"})[0], 401)
            route = f"/v1/chats/{current}/history"
            page = json.loads(self.request("GET", route)[1])
            self.assertEqual([turn["id"] for turn in page["turns"]], list(map(str, range(4, 34))))
            older = json.loads(self.request("GET", f"{route}?before_seq={page['older_before_seq']}")[1])
            self.assertEqual([turn["id"] for turn in older["turns"]], ["0", "1", "2", "3"])
            self.assertIsNone(older["older_before_seq"])
            self.assertEqual(self.request("GET", f"{route}?before_seq=9223372036854775808")[0], 400)

    def test_late_completion_cannot_publish_over_newer_job(self):
        older, newer = (str(uuid4()) for _ in range(2))
        self.analyzer.block_event_id = older
        old_job = self.submit(older)
        self.assertTrue(self.analyzer.started.wait(3))
        self.assertEqual(self.events(self.submit(newer, offset=1_000_000))[-1], "job.result")
        self.analyzer.release.set()
        self.assertEqual(self.events(old_job), ["job.status", "job.status", "job.canceled"])

    def test_cancel_prevents_result(self):
        canceled, followup = (str(uuid4()) for _ in range(2))
        self.analyzer.block_event_id = canceled
        job = self.submit(canceled)
        self.assertTrue(self.analyzer.started.wait(3))
        self.assertEqual(self.request("DELETE", f"/v1/jobs/{job}")[0], 200)
        self.analyzer.release.set()
        self.assertEqual(self.events(job), ["job.status", "job.status", "job.canceled"])
        self.assertEqual(self.events(self.submit(followup, offset=1_000_000))[-1], "job.result")

    def test_baseline_publishes_three_fields_before_compatible_result(self):
        self.server.state.analyzer = BaselineAnalyzer(FixtureProvider())
        job = self.submit(str(uuid4()))
        status, text = self.request("GET", f"/v1/jobs/{job}/events", headers={"Last-Event-ID": "2"})
        self.assertEqual(status, 200)
        events = [line for line in text.splitlines() if line.startswith(("event: ", "data: "))]
        self.assertEqual([events[0], events[2]], ["event: job.analysis", "event: job.result"])
        analysis = json.loads(events[1].removeprefix("data: "))
        compat = json.loads(events[3].removeprefix("data: "))
        self.assertTrue(analysis["suspected_confusion"])
        self.assertEqual(analysis["possible_questions"][0], compat["likely_question"])
        self.assertEqual(analysis["summary"], compat["answer"])

    def test_desktop_gaze_v2_available_and_score_only(self):
        provider = FixtureProvider()
        self.server.state.analyzer = BaselineAnalyzer(provider)
        width = self.manifest["viewport_width_px"]
        height = self.manifest["viewport_height_px"]
        duration = self.manifest["clip_end_us"] - self.manifest["clip_start_us"]
        missing = {"average_x": None, "average_y": None, "maxbox": None,
                   "fusion_mode": "unavailable", "confidence": 0.64}
        samples = [{"time_us": t, **missing} for t in range(0, duration, 200_000)]
        gaze = {"schema_version": 2, "timebase": "clip_relative_us", "step_us": 200_000,
                "viewport_width_px": width, "viewport_height_px": height, "samples": samples}
        score_only = self.submit(str(uuid4()), gaze=gaze, gaze_status="unavailable")
        self.assertEqual(self.events(score_only)[-2:], ["job.analysis", "job.result"])
        box = {"x": 20, "y": 20, "w": 10, "h": 10}
        samples[0].update(average_x=25, average_y=25, maxbox=box,
                          x_model1=21, y_model1=23, x_model2=29, y_model2=27, fusion_mode="paired")
        with_gaze = self.submit(str(uuid4()), offset=1_000_000, gaze=gaze, gaze_status="available")
        self.assertEqual(self.events(with_gaze)[-2:], ["job.analysis", "job.result"])
        sent = provider.context["gaze"][0]
        for key in ("time_us", "x_model1", "y_model1", "x_model2", "y_model2",
                    "average_x", "average_y", "maxbox", "confidence"):
            self.assertEqual(sent[key], samples[0][key])
        error = self.submit(str(uuid4()), gaze={**gaze, "viewport_width_px": width + 1},
                            gaze_status="available", expected=400)
        self.assertIn("gaze geometry", error)
        error = self.submit(str(uuid4()), gaze=gaze, gaze_status="unavailable", expected=400)
        self.assertIn("gaze_status", error)
