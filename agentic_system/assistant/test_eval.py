"""Offline checks for the Ojos replay evaluator.

These tests do not call Gemini.  They skip while the shared Tutor implementation
is absent, which keeps the evaluator usable during the parallel workstream
handoff.
"""

from __future__ import annotations

import unittest

try:
    from . import eval as replay_eval
    from .core import Tutor  # noqa: F401
except ImportError:  # pragma: no cover - expected before core lands.
    replay_eval = None


@unittest.skipIf(replay_eval is None, "assistant.core is not present yet")
class ReplayEvalTests(unittest.TestCase):
    def test_scripted_suite_is_deterministic_and_contract_focused(self) -> None:
        first = replay_eval.run_eval()
        second = replay_eval.run_eval()
        self.assertEqual(first["mode"], "scripted")
        self.assertEqual(first["automated_failed"], 0, first)
        self.assertEqual(first["automated_passed"], second["automated_passed"])
        self.assertEqual(first["human_review_pending"], 1)

    def test_scripted_provider_records_media_variant(self) -> None:
        provider = replay_eval.DemoProvider(
            [
                {
                    "action": "ask",
                    "task_state": "new",
                    "task": "Python list indexing",
                    "sticking_point": "valid index range",
                    "question": "What is the highest valid index?",
                    "evidence": [{"time_us": 3_600_000, "detail": "The list is visible."}],
                }
            ]
        )
        with replay_eval._fixture_scope():
            tutor = Tutor(provider, variant="video")
            analysis = tutor.analyze(replay_eval._make_clip(event_id="test-provider"), variant="video")
        self.assertTrue(provider.calls)
        self.assertEqual(provider.calls[0]["frame_count"], 0)
        self.assertEqual(replay_eval._status(replay_eval._result_dict(analysis)), "ask")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
