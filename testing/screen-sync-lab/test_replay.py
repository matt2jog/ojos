import unittest

from replay import (
    CaptureGeometry,
    GazeSample,
    IntervalEvent,
    ScreenFrame,
    gaze_payload,
    map_normalized_gaze_to_frame,
    plan_clip,
    resample_gaze,
    run_replay,
    select_prior_frame,
)


class ReplayTests(unittest.TestCase):
    def test_synthetic_replay_passes(self):
        result = run_replay()
        self.assertTrue(result["all_checks_pass"], result["checks"])
        self.assertEqual(result["gaze_export"]["sample_count"], 75)
        self.assertEqual(
            result["gaze_export"]["wire_examples"]["samples"][1],
            {
                "time_us": 5_800_000,
                "x_px": None,
                "y_px": None,
                "uncertainty_radius_px": None,
                "valid": False,
            },
        )

    def test_prior_frame_never_looks_forward(self):
        frames = [
            ScreenFrame(1, 1_000, True),
            ScreenFrame(2, 2_000, False),
        ]
        selected = select_prior_frame(frames, 1_500, 0)
        self.assertTrue(selected.ok)
        self.assertEqual(selected.frame_id, 1)

    def test_stale_prior_frame_is_invalid_at_presentation_end(self):
        frames = [
            ScreenFrame(1, 1_000, True, duration_us=100),
            ScreenFrame(2, 2_000, False, duration_us=100),
        ]
        self.assertEqual(select_prior_frame(frames, 1_099, 0).frame_id, 1)
        gap = select_prior_frame(frames, 1_100, 0)
        self.assertFalse(gap.ok)
        self.assertEqual(gap.reason, "screen_frame_gap")
        self.assertIsNone(gap.frame_id)

    def test_epoch_change_does_not_mix_frames(self):
        frames = [
            ScreenFrame(1, 1_000, True, 0),
            ScreenFrame(2, 2_000, True, 1),
        ]
        selected = select_prior_frame(frames, 2_500, 1)
        self.assertEqual(selected.frame_id, 2)
        missing = select_prior_frame(frames, 1_500, 1)
        self.assertFalse(missing.ok)
        self.assertEqual(missing.reason, "no_prior_frame")

    def test_gap_is_invalid_on_grid(self):
        samples = [
            GazeSample(1_000, 10, 20, 3, True),
            GazeSample(300_000, 20, 30, 4, True),
        ]
        output = resample_gaze(samples, 100_000, 500_000, grid_us=100_000)
        self.assertFalse(output[0].valid)
        self.assertEqual(output[0].reason, "gap_too_large")

    def test_gap_at_interpolation_limit_is_invalid(self):
        samples = [
            GazeSample(10_000, 10, 20, 3, True),
            GazeSample(110_000, 20, 30, 4, True),
        ]
        output = resample_gaze(samples, 60_000, 70_000)
        self.assertEqual(output[0].reason, "gap_too_large")

    def test_unavailable_gaze_has_empty_wire_payload(self):
        samples = [GazeSample(200_000, 10, 20, None, True)]
        output = resample_gaze(samples, 200_000, 600_000)
        self.assertEqual([sample.time_us for sample in output], [0, 200_000])
        self.assertEqual(output[0].reason, "invalid_source_values")
        self.assertEqual(gaze_payload(output), {"schema_version": 1, "samples": []})

    def test_invalid_sample_breaks_interpolation(self):
        samples = [
            GazeSample(1_000, 10, 20, 3, True),
            GazeSample(50_000, None, None, None, False, "blink"),
            GazeSample(90_000, 20, 30, 4, True),
        ]
        output = resample_gaze(samples, 40_000, 41_000, grid_us=1_000)
        self.assertFalse(output[0].valid)
        self.assertEqual(output[0].reason, "blink")

    def test_capture_crop_and_scale_mapping(self):
        geometry = CaptureGeometry(2560, 1440, 320, 180, 1920, 1080, 960, 540)
        point = map_normalized_gaze_to_frame(0.75, 0.5, geometry)
        self.assertAlmostEqual(point.x_px, 800)
        self.assertAlmostEqual(point.y_px, 270)

    def test_rotated_crop_top_left_stays_inside_viewport(self):
        geometry = CaptureGeometry(2560, 1440, 320, 180, 1920, 1080, 540, 960, 90)
        point = map_normalized_gaze_to_frame(0.125, 0.125, geometry)
        self.assertLess(point.x_px, 540)
        self.assertAlmostEqual(point.x_px, 540)
        self.assertEqual(point.y_px, 0)

    def test_gaze_outside_captured_rectangle_fails_loudly(self):
        geometry = CaptureGeometry(2560, 1440, 320, 180, 1920, 1080, 960, 540)
        with self.assertRaisesRegex(ValueError, "outside"):
            map_normalized_gaze_to_frame(0.01, 0.01, geometry)

    def test_clip_uses_remaining_keyframe_and_media_after_ring_eviction(self):
        event = IntervalEvent(
            session_id="test-session",
            capture_epoch=0,
            event_id="test-event",
            source="replay",
            start_us=14_000_000,
            end_us=18_000_000,
            first_frame_id=112,
            last_frame_id=143,
            score=0.82,
            model_version="test",
        )
        frames = [
            ScreenFrame(1, 9_900_000, False),
            ScreenFrame(2, 10_000_000, True),
            ScreenFrame(3, 17_100_000, False),
            ScreenFrame(4, 19_000_000, True, capture_epoch=1),
        ]
        clip = plan_clip(event, frames)
        self.assertTrue(clip.ok)
        self.assertEqual((clip.requested_start_us, clip.requested_end_us), (4_000_000, 19_000_000))
        self.assertEqual((clip.actual_start_us, clip.actual_end_us), (10_000_000, 17_200_000))
        self.assertFalse(plan_clip(event, [ScreenFrame(4, 18_000_000, True)]).ok)


if __name__ == "__main__":
    unittest.main()
