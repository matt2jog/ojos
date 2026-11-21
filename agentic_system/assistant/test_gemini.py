import base64
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError


sys.path.insert(0, str(Path(__file__).parent))

from gemini import GeminiProvider, ProviderError  # noqa: E402


class _Response:
    status = 200

    def __init__(self, body: bytes):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, limit: int = -1):
        return self.body if limit < 0 else self.body[:limit]


class GeminiProviderTests(unittest.TestCase):
    def setUp(self):
        self.provider = GeminiProvider("test-key", "gemini-4-hydrogen", thinking="low", timeout=3)
        self.schema = {
            "type": "object",
            "properties": {"question": {"type": "string"}},
            "required": ["question"],
            "additionalProperties": False,
        }

    def test_build_request_contains_screen_media_and_stateless_config(self):
        body = self.provider.build_request(
            system_instruction="Ask one grounded study question.",
            context={"session_id": "s-1", "memory": {"stuck_on": "list index"}},
            video=b"mp4-bytes",
            frames=((1_500_000, b"jpeg-bytes"),),
            response_schema=self.schema,
        )
        request = json.loads(body)
        self.assertEqual(request["model"], "gemini-4-hydrogen")
        self.assertFalse(request["store"])
        self.assertEqual(request["generation_config"], {"thinking_level": "low"})
        self.assertEqual(request["response_format"]["mime_type"], "application/json")
        self.assertEqual(request["input"][1]["type"], "video")
        self.assertEqual(request["input"][1]["data"], base64.b64encode(b"mp4-bytes").decode())
        image = next(part for part in request["input"] if part.get("type") == "image")
        self.assertEqual(image["mime_type"], "image/jpeg")
        self.assertEqual(image["data"], base64.b64encode(b"jpeg-bytes").decode())
        self.assertIn("1500000", json.dumps(request["input"]))

    @patch("gemini.urlopen")
    def test_generate_parses_final_model_output_and_usage(self, urlopen):
        payload = {
            "status": "completed",
            "steps": [
                {"type": "thought", "content": [{"type": "text", "text": "internal"}]},
                {
                    "type": "model_output",
                    "content": [
                        {"type": "text", "text": '{"question":"Which index is valid?"}'},
                    ],
                },
            ],
            "usage": {"total_input_tokens": 42, "total_output_tokens": 12},
        }
        urlopen.return_value = _Response(json.dumps(payload).encode())

        generation = self.provider.generate(
            system_instruction="Ask one grounded study question.",
            context={"clip_duration_us": 8_000_000},
            video=None,
            frames=(),
            response_schema=self.schema,
        )

        self.assertEqual(generation.value["question"], "Which index is valid?")
        self.assertEqual(generation.usage["total_input_tokens"], 42)
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://generativelanguage.googleapis.com/v1beta/interactions")
        self.assertEqual(request.get_header("X-goog-api-key"), "test-key")
        self.assertEqual(request.get_header("Content-type"), "application/json")

    @patch("gemini.urlopen")
    def test_generate_rejects_incomplete_interaction_without_leaking_body(self, urlopen):
        urlopen.return_value = _Response(b'{"status":"failed","error":"secret prompt"}')
        with self.assertRaisesRegex(ProviderError, "did not complete") as raised:
            self.provider.generate(
                system_instruction="Ask one grounded study question.",
                context={},
                video=None,
                frames=(),
                response_schema=self.schema,
            )
        self.assertNotIn("secret prompt", str(raised.exception))

    @patch("gemini.urlopen")
    def test_generate_maps_http_error_to_safe_provider_error(self, urlopen):
        urlopen.side_effect = HTTPError(
            "https://generativelanguage.googleapis.com/v1beta/interactions",
            429,
            "quota includes secret",
            {},
            None,
        )
        with self.assertRaisesRegex(ProviderError, "HTTP 429"):
            self.provider.generate(
                system_instruction="Ask one grounded study question.",
                context={},
                video=None,
                frames=(),
                response_schema=self.schema,
            )


if __name__ == "__main__":
    unittest.main()
