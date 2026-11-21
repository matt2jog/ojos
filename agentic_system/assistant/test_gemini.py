import unittest
from unittest.mock import AsyncMock, patch

from .gemini import GeminiProvider, Generation, ProviderError


class GeminiProviderTests(unittest.TestCase):
    def setUp(self):
        self.provider = GeminiProvider("test-key", "gemini-4-hydrogen")
        self.inputs = dict(system_instruction="Summarize the screen.", context={"event_start_us": 5_000_000},
                           video=b"mp4", frames=((4_000_000, b"jpeg"),), response_schema={"type": "object"})

    def test_dispatch_preserves_video_and_still_timestamp(self):
        with patch.object(self.provider, "_run", new=AsyncMock(return_value=Generation({"summary": "ok"}))) as run:
            self.assertEqual(self.provider.generate(**self.inputs).value, {"summary": "ok"})
        self.assertEqual(run.call_args.args[2:4], (b"mp4", ((4_000_000, b"jpeg"),)))

    def test_oversized_inline_clip_is_rejected_before_provider_use(self):
        with patch("agentic_system.assistant.gemini.MAX_INLINE_BYTES", 16_386):
            with self.assertRaisesRegex(ProviderError, "request limit"):
                self.provider.generate(**self.inputs)

    def test_provider_failure_does_not_echo_payload(self):
        with patch.object(self.provider, "_run", new=AsyncMock(side_effect=RuntimeError("private text"))):
            with self.assertRaisesRegex(ProviderError, "^Gemini clip analysis failed\\.$"):
                self.provider.generate(**self.inputs)
