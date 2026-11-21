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

from .baseline import BaselineAnalyzer, DemoBaselineProvider
from .core import Analysis, Memory, result_record
from .server import build_server


class FakeTutor:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.block_event_id = None
        self.memories = {}

    def analyze(self, clip, *, memory, reply, variant):
        self.memories[clip.event_id] = memory
        if clip.event_id == self.block_event_id:
            self.started.set()
            if not self.release.wait(8):
                raise TimeoutError("test timed out")
        task = f"Test event {clip.event_id}"
        question = "Which index does this code access?"
        return Analysis(result_record(question, task=task, evidence=[{"time_us": 0, "detail": "A Python list is visible."}]),
                        Memory(task, "list indexing", question), {})


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
        self.tutor = FakeTutor()
        self.server = build_server(self.tutor, token="local-test", port=0)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.state.stop)
        self.addCleanup(self.server.shutdown)
        self.addCleanup(self.tutor.release.set)
        self.session_id = str(uuid4())

    def request(self, method, path, body=None, headers=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=8)
        try:
            connection.request(method, path, body, {"Authorization": "Bearer local-test", **(headers or {})})
            response = connection.getresponse()
            return response.status, response.read().decode()
        finally:
            connection.close()

    def submit(self, event_id, offset=0, epoch=0):
        manifest = {**self.manifest, "session_id": self.session_id, "event_id": event_id, "capture_epoch": epoch}
        for field in ("clip_start_us", "clip_end_us", "event_start_us", "event_end_us"):
            manifest[field] += offset
        fields = (("manifest", json.dumps(manifest).encode()), ("gaze", self.gaze), ("video", self.video))
        boundary = f"ojos-test-{uuid4().hex}"
        body = b"".join(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'.encode() + value + b"\r\n"
                        for name, value in fields) + f"--{boundary}--\r\n".encode()
        status, text = self.request("POST", "/v1/jobs", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
        self.assertEqual(status, 202, text)
        return json.loads(text)["job_id"]

    def events(self, job_id, last_id=None):
        headers = {"Last-Event-ID": str(last_id)} if last_id is not None else None
        status, text = self.request("GET", f"/v1/jobs/{job_id}/events", headers=headers)
        self.assertEqual(status, 200, text)
        return [line.removeprefix("event: ") for line in text.splitlines() if line.startswith("event: ")]

    def test_retry_sse_resume_and_memory_across_pings(self):
        first, followup, new_epoch = (str(uuid4()) for _ in range(3))
        first_job = self.submit(first)
        self.assertEqual(self.submit(first), first_job)
        self.assertEqual(self.events(first_job), ["job.status", "job.status", "job.result"])
        self.assertEqual(self.events(first_job, last_id=2), ["job.result"])
        self.assertEqual(self.events(self.submit(followup, offset=1_000_000))[-1], "job.result")
        self.assertEqual(self.tutor.memories[followup].task, f"Test event {first}")
        self.assertEqual(self.events(self.submit(new_epoch, epoch=1))[-1], "job.result")
        self.assertIsNone(self.tutor.memories[new_epoch])

    def test_late_completion_cannot_overwrite_newer_memory(self):
        older, newer, followup = (str(uuid4()) for _ in range(3))
        self.tutor.block_event_id = older
        old_job = self.submit(older)
        self.assertTrue(self.tutor.started.wait(3))
        self.assertEqual(self.events(self.submit(newer, offset=1_000_000))[-1], "job.result")
        self.tutor.release.set()
        self.assertEqual(self.events(old_job)[-1], "job.canceled")
        self.assertEqual(self.events(self.submit(followup, offset=2_000_000))[-1], "job.result")
        self.assertEqual(self.tutor.memories[followup].task, f"Test event {newer}")

    def test_cancel_prevents_result_and_memory_update(self):
        canceled, followup = (str(uuid4()) for _ in range(2))
        self.tutor.block_event_id = canceled
        job = self.submit(canceled)
        self.assertTrue(self.tutor.started.wait(3))
        self.assertEqual(self.request("DELETE", f"/v1/jobs/{job}")[0], 200)
        self.tutor.release.set()
        self.assertEqual(self.events(job)[-1], "job.canceled")
        self.assertEqual(self.events(self.submit(followup, offset=1_000_000))[-1], "job.result")
        self.assertIsNone(self.tutor.memories[followup])

    def test_baseline_publishes_three_fields_before_compatible_result(self):
        self.server.state.tutor = BaselineAnalyzer(DemoBaselineProvider())
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
