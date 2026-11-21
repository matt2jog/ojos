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
        output = validate_analysis({**self.generated, "status": "insufficient_evidence"}, self.clip, None)
        self.assertIsNone(output["suspected_confusion"])
        self.assertEqual(output["possible_questions"], [])
        self.assertEqual(output["evidence"], [])
        self.assertIn("identify the task", output["summary"])

    def test_evidence_for_a_still_must_point_to_a_supplied_timestamp(self):
        with self.assertRaisesRegex(ProviderError, "attached still"):
            validate_analysis(self.generated, self.clip, {500_000})
        output = validate_analysis(self.generated, self.clip, {1_000_000})
        self.assertEqual(output["schema_version"], 1)
