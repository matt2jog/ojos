"""Regression checks for chunk state and vision worker event boundaries."""

import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from evaluate_intervals import match
from intervals import Intervals
from preprocess import Sampler

SESSION = "77510d91-432d-4c51-b2e6-59cb27986589"
STEP = 125_000


class IntervalTests(unittest.TestCase):
    def run_scores(self, detector, start, end, score):
        events = []
        for frame in range(start, end):
            event = detector.step(frame * STEP, frame, score)
            if event:
                events.append(event)
        return events

    def test_protocol_recovery_example(self):
        fixture = Path(__file__).with_name("fixtures") / "recovery.jsonl"
        detector = Intervals(SESSION, "test", "replay")
        events = []
        with fixture.open(encoding="utf-8") as source:
            for line in source:
                sample = json.loads(line)
                event = detector.step(sample["time_us"], sample["frame_id"], sample["probability"],
                                      reset=sample.get("reset", False))
                if event:
                    events.append((event, sample["time_us"]))
        (event, published_us), = events
        self.assertEqual(event["source"], "replay")
        self.assertEqual((event["start_us"], event["end_us"], published_us), (14_000_000, 18_000_000, 19_000_000))
        self.assertEqual((event["first_frame_id"], event["last_frame_id"]), (112, 143))

    def test_sustained_score_caps_at_eight_seconds_and_requires_rearm(self):
        detector = Intervals(SESSION, "test", "live")
        first, = self.run_scores(detector, 0, 130, 1.0)
        self.assertEqual((first["start_us"], first["end_us"], first["last_frame_id"]), (4_000_000, 12_000_000, 95))
        self.assertFalse(self.run_scores(detector, 130, 155, 0.0))
        self.assertFalse(self.run_scores(detector, 155, 232, 1.0))
        self.assertFalse(self.run_scores(detector, 232, 256, 0.0))
        second, = self.run_scores(detector, 256, 360, 1.0)
        self.assertEqual(second["end_us"] - second["start_us"], 8_000_000)
        self.assertNotEqual(second["event_id"], first["event_id"])

    def test_camera_loss_discards_pending_event_and_rewarms(self):
        detector = Intervals(SESSION, "test", "live")
        self.assertFalse(self.run_scores(detector, 0, 50, 1.0))
        self.assertFalse(self.run_scores(detector, 50, 56, None))
        event, = self.run_scores(detector, 56, 155, 1.0)
        self.assertEqual((event["start_us"], event["end_us"]), (11_000_000, 19_000_000))

    def test_cooldown_survives_epoch_restart(self):
        detector = Intervals(SESSION, "test", "live")
        self.run_scores(detector, 0, 100, 1.0)
        detector.start_epoch(1)
        for frame in range(40):
            self.assertIsNone(detector.step((100 + frame) * STEP, frame, 0.0))
        self.assertEqual(detector.published_us, 12_000_000)

    def test_sampler_uses_a_distinct_frame_and_counts_unserved_ticks(self):
        sampler = Sampler(8)
        self.assertEqual([sampler.take(t) for t in (0, 0, 25_000, 140_000, 490_000, 500_000)],
                         [True, False, False, True, True, True])
        self.assertEqual(sampler.skipped_ticks, 1)

    def test_matching_can_reassign_a_prediction_to_match_both(self):
        def span(start, end):
            return {"capture_epoch": 0, "start_us": start, "end_us": end}
        self.assertEqual(len(match([span(0, 11), span(0, 6)], [span(0, 7), span(7, 12)])), 2)


class PreparationTests(unittest.TestCase):
    def test_official_split_and_level_mapping_from_archive(self):
        from prepare import daisee, subset, validate_splits

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "sample.zip"
            with zipfile.ZipFile(path, "w") as archive:
                for split in ("Train", "Validation", "Test"):
                    rows = ["ClipID,Boredom,Engagement,Confusion,Frustration"]
                    for level in range(4):
                        name = f"{split}{level}"
                        archive.writestr(f"DAiSEE/DataSet/{split}/{split}-person/{name}/{name}.avi", b"")
                        rows.append(f"{name}.avi,0,0,{level},0")
                    archive.writestr(f"DAiSEE/Labels/{split}Labels.csv", "\n".join(rows))
            clips = daisee(path)
            validate_splits(clips)
            self.assertEqual([c.label for c in clips], [0, 0, 1, 1] * 3)
            self.assertEqual(len(subset(clips, 1)), 6)


class TrainingTests(unittest.TestCase):
    def test_chunk_pooling_matches_streaming_across_two_tracks(self):
        import torch

        from model import ConfusionModel
        from train import clip_scores

        torch.set_num_threads(1)
        torch.manual_seed(1)
        model = ConfusionModel().eval()
        frames = torch.randn(19, 3, 112, 112)
        tracks = [[frames[:5], frames[5:10]], [frames[10:]]]
        with torch.inference_mode():
            batched = clip_scores(model, [({"usable": 19}, tracks)], "cpu")
            scores = []
            for chunks in tracks:
                hidden = torch.zeros(1, 1, 128)
                for frame in torch.cat(chunks):
                    probabilities, hidden = model(frame[None], hidden)
                    scores.append(probabilities[0, 1])
        torch.testing.assert_close(batched[0], torch.stack(scores).mean())

    def test_state_does_not_backpropagate_across_four_second_chunks(self):
        import torch

        from train import clip_scores

        class Cumulative:
            gru = True

            def encode(self, frames):
                return frames[:, 0, 0, :]

            def classify(self, projected, initial):
                state = projected.cumsum(dim=1)
                if initial is not None:
                    state = state + initial.transpose(0, 1)
                return torch.cat((torch.zeros_like(state), state), dim=-1), state

        frames = torch.zeros((2, 1, 1, 1), requires_grad=True)
        tracks = [[frames[:1], frames[1:]]]
        clip_scores(Cumulative(), [({"usable": 2}, tracks)], "cpu").sum().backward()
        torch.testing.assert_close(frames.grad.flatten(), torch.tensor([0.125, 0.125]))


if __name__ == "__main__":
    unittest.main()
