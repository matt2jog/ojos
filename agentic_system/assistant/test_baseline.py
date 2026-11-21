import unittest
from pathlib import Path

from .baseline import validate_analysis
from .gemini import ProviderError
from .media import Clip


class BaselineValidationTests(unittest.TestCase):
    def setUp(self):
        self.clip = Clip(Path("unused.mp4"), "session", "event", 0, 0, 0, 2_000_000, 2_000_000, 640, 360, "replay")
        self.generated = {
            "status": "analyzed",
            "suspected_confusion": "The learner may be unsure about zero-based indexing.",
            "possible_questions": ["Which index accesses the last item?"],
            "summary": "Count the three entries from index zero.",
            "evidence": [{"time_us": 1_000_000, "detail": "Three list entries are visible."}],
        }

    def test_weak_model_output_cannot_display_unsupported_claims(self):
        output = validate_analysis({**self.generated, "status": "insufficient_evidence"}, self.clip)
        self.assertIsNone(output["suspected_confusion"])
        self.assertEqual(output["possible_questions"], [])
        self.assertEqual(output["evidence"], [])
        self.assertIn("identify the task", output["summary"])

    def test_evidence_must_fall_inside_the_clip(self):
        outside = {**self.generated, "evidence": [{"time_us": 2_000_000, "detail": "Three items."}]}
        with self.assertRaisesRegex(ProviderError, "outside the clip"):
            validate_analysis(outside, self.clip)
        output = validate_analysis(self.generated, self.clip)
        self.assertEqual(output["schema_version"], 1)
