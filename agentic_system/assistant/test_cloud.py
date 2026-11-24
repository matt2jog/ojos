from http.client import HTTPConnection
from io import BytesIO
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from uuid import uuid4

from .adk_chat import ChatService
from .cloud import build_server
from .test_server import FixtureAnalyzer

TOKEN = "a" * 40


class CloudTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.key = "configured-key"
        self.server = build_server(0, TOKEN, lambda: self.key, lambda _key: FixtureAnalyzer())
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def request(self, method, path, body=None, *, authorized=True, content_type="application/json"):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=8)
        try:
            headers = {"Content-Type": content_type}
            if authorized:
                headers["Authorization"] = f"Bearer {TOKEN}"
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_readiness_authentication_and_route_allowlist(self):
        self.key = ""
        self.assertEqual(self.request("GET", "/health", authorized=False),
                         (200, {"status": "ok", "gemini_configured": False}))
        self.assertEqual(self.request("POST", "/v1/analyze", b"a", authorized=False)[0], 401)
        self.assertEqual(self.request("POST", "/v1/analyze", b"a"),
                         (503, {"error": "gemini_unconfigured"}))
        self.key = "configured-key"
        self.assertEqual(self.request("POST", "/gemini/v1beta/files", b"{}")[0], 404)
        self.assertEqual(self.request("POST", "/gemini/v1beta/models/other:generateContent", b"{}")[0], 404)
        self.assertEqual(self.request("POST", "/v1/analyze", b"unparseable")[0], 400)

    def test_clip_analysis_returns_evidence_in_the_upload_request(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(__file__).resolve().parents[2]
            bundle = Path(temporary) / "clip"
            subprocess.run(
                [sys.executable, str(root / "testing/screen-sync-lab/media/generate.py"), "--output-dir", str(bundle)],
                check=True, capture_output=True, timeout=30,
            )
            boundary = uuid4().hex
            fields = (("manifest", "manifest.json"), ("gaze", "gaze.json"), ("video", "video.mp4"))
            body = b"".join(
                f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"\r\n\r\n'.encode()
                + (bundle / name).read_bytes() + b"\r\n"
                for field, name in fields
            ) + f"--{boundary}--\r\n".encode()
        status, result = self.request("POST", "/v1/analyze", body,
                                      content_type=f"multipart/form-data; boundary={boundary}")
        self.assertEqual(status, 200)
        self.assertEqual(result["evidence"][0]["time_us"], 0)
        self.assertEqual(len(result["possible_questions"]), 1)

    async def test_genai_sdk_streams_through_cloud_with_server_side_key(self):
        requests = []

        class Response(BytesIO):
            status = 200
            headers = {"Content-Type": "text/event-stream"}

        class Upstream:
            def open(self, request, **_options):
                requests.append(request)
                result = {"candidates": [{"content": {"role": "model", "parts": [{"text": "hello"}]}}]}
                return Response(f"data: {json.dumps(result)}\n\n".encode())

        self.server.upstream = Upstream()
        with tempfile.TemporaryDirectory() as directory:
            chat = ChatService("ojos", "gemini-4-hydrogen", Path(directory) / "chat.db", [],
                               relay_url=f"http://127.0.0.1:{self.server.server_port}/gemini", cloud_token=TOKEN)
            async with chat.client() as (_, client):
                stream = await client.models.generate_content_stream(model=chat.model, contents="hello")
                texts = [message.text async for message in stream]
        self.assertEqual(texts, ["hello"])
        (request,) = requests
        self.assertTrue(request.full_url.endswith("/gemini-4-hydrogen:streamGenerateContent?alt=sse"))
        self.assertEqual(request.get_header("X-goog-api-key"), "configured-key")
        self.assertIsNone(request.get_header("Authorization"))
