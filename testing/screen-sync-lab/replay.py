#!/usr/bin/env python3
"""Replay the first screen and gaze fixture on a synthetic session clock."""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import asdict, dataclass, replace
from typing import Any, Iterable, Optional, Sequence
from uuid import uuid4


SECOND_US = 1_000_000
GAZE_GRID_US = 200_000
# The grid comes from protocol v1. The gap cutoff is a local replay policy.
MAX_GAZE_GAP_US = 100_000


@dataclass(frozen=True)
class ScreenFrame:
    frame_id: int
    pts_us: int
    keyframe: bool
    capture_epoch: int = 0
    duration_us: int = 100_000

    @property
    def end_us(self) -> int:
        return self.pts_us + self.duration_us


@dataclass(frozen=True)
class IntervalEvent:
    session_id: str
    capture_epoch: int
    event_id: str
    source: str
    start_us: int
    end_us: int
    first_frame_id: int
    last_frame_id: int
    score: float
    model_version: str


@dataclass(frozen=True)
class FrameSelection:
    ok: bool
    frame_id: Optional[int] = None
    pts_us: Optional[int] = None
    reason: Optional[str] = None


@dataclass(frozen=True)
class ClipPlan:
    ok: bool
    requested_start_us: int
    requested_end_us: int
    actual_start_us: Optional[int] = None
    actual_end_us: Optional[int] = None
    decode_keyframe_id: Optional[int] = None
    reason: Optional[str] = None


@dataclass(frozen=True)
class CaptureGeometry:
    """Crop origin in selected-display pixels, dimensions in encoded pixels."""

    display_width_px: int
    display_height_px: int
    capture_left_px: int
    capture_top_px: int
    capture_width_px: int
    capture_height_px: int
    frame_width_px: int
    frame_height_px: int
    orientation_deg: int = 0


@dataclass(frozen=True)
class PixelPoint:
    x_px: float
    y_px: float


@dataclass(frozen=True)
class GazeSample:
    time_us: int
    x_px: Optional[float]
    y_px: Optional[float]
    uncertainty_radius_px: Optional[float]
    valid: bool
    reason: Optional[str] = None


def select_prior_frame(
    frames: Iterable[ScreenFrame], target_us: int, capture_epoch: int
) -> FrameSelection:
    """Find the newest frame covering the observation on the active epoch."""
    prior = max(
        (frame for frame in frames if frame.capture_epoch == capture_epoch
         and frame.pts_us <= target_us),
        key=lambda frame: (frame.pts_us, frame.frame_id),
        default=None,
    )
    if prior is None:
        return FrameSelection(False, reason="no_prior_frame")
    if target_us >= prior.end_us:
        return FrameSelection(False, reason="screen_frame_gap")
    return FrameSelection(True, prior.frame_id, prior.pts_us)


def plan_clip(
    event: IntervalEvent,
    frames: Sequence[ScreenFrame],
    pre_roll_us: int = 10 * SECOND_US,
    post_roll_us: int = SECOND_US,
) -> ClipPlan:
    """Plan automatic export bounds from retained frame metadata."""
    requested_start = max(0, event.start_us - pre_roll_us)
    requested_end = event.end_us + post_roll_us
    requested = ClipPlan(False, requested_start, requested_end)
    epoch_frames = sorted(
        (frame for frame in frames if frame.capture_epoch == event.capture_epoch),
        key=lambda frame: frame.pts_us,
    )
    if not epoch_frames:
        return replace(requested, reason="no_media_in_epoch")

    keyframes = [frame for frame in epoch_frames if frame.keyframe]
    if not keyframes:
        return replace(requested, reason="no_keyframe")
    # If the preceding keyframe was evicted, use the first one still retained.
    keyframe = next(
        (frame for frame in reversed(keyframes) if frame.pts_us <= requested_start),
        keyframes[0],
    )
    actual_start = keyframe.pts_us
    actual_end = min(requested_end, epoch_frames[-1].end_us)
    if max(event.start_us, actual_start) >= min(event.end_us, actual_end):
        return replace(requested, reason="event_outside_available_media")
    return ClipPlan(True, requested_start, requested_end, actual_start, actual_end, keyframe.frame_id)


def map_normalized_gaze_to_frame(
    x_norm: float, y_norm: float, geometry: CaptureGeometry
) -> PixelPoint:
    """Map a display-normalized point through crop, clockwise rotation and scale."""
    if not (0 <= x_norm <= 1 and 0 <= y_norm <= 1):
        raise ValueError("normalized gaze must be inside [0, 1]")
    display_x = x_norm * geometry.display_width_px
    display_y = y_norm * geometry.display_height_px
    u = (display_x - geometry.capture_left_px) / geometry.capture_width_px
    v = (display_y - geometry.capture_top_px) / geometry.capture_height_px
    if not (0 <= u <= 1 and 0 <= v <= 1):
        raise ValueError("gaze falls outside the captured rectangle")
    orientations = {0: (u, v), 90: (1 - v, u), 180: (1 - u, 1 - v), 270: (v, 1 - u)}
    oriented = orientations.get(geometry.orientation_deg % 360)
    if oriented is None:
        raise ValueError("orientation_deg must be a multiple of 90")

    x, y = oriented
    width, height = geometry.frame_width_px, geometry.frame_height_px
    # Rotation can put an edge exactly at width or height. Keep it in the viewport.
    return PixelPoint(
        min(x * width, math.nextafter(width, 0.0)),
        min(y * height, math.nextafter(height, 0.0)),
    )


def _invalid_gaze(time_us: int, reason: str) -> GazeSample:
    return GazeSample(time_us, None, None, None, False, reason)


def _gaze_values(sample: GazeSample) -> Optional[tuple[float, float, float]]:
    x, y, radius = sample.x_px, sample.y_px, sample.uncertainty_radius_px
    if x is None or y is None or radius is None:
        return None
    values = (x, y, radius)
    if any(not math.isfinite(value) or value < 0 for value in values):
        return None
    return values


def _resample_one(
    samples: Sequence[GazeSample], target_us: int, relative_us: int, max_gap_us: int
) -> GazeSample:
    before = next((sample for sample in reversed(samples) if sample.time_us <= target_us), None)
    after = next((sample for sample in samples if sample.time_us >= target_us), None)
    if before is None or after is None:
        return _invalid_gaze(relative_us, "outside_reliable_history")

    for sample in (before, after):
        if not sample.valid:
            return _invalid_gaze(relative_us, sample.reason or "invalid_source")
    first, last = _gaze_values(before), _gaze_values(after)
    if first is None or last is None:
        return _invalid_gaze(relative_us, "invalid_source_values")
    if before.time_us == target_us:
        return replace(before, time_us=relative_us)

    gap = after.time_us - before.time_us
    if gap >= max_gap_us:
        return _invalid_gaze(relative_us, "gap_too_large")
    fraction = (target_us - before.time_us) / gap
    x, y, radius = (start + fraction * (end - start) for start, end in zip(first, last))
    return GazeSample(relative_us, x, y, radius, True)


def resample_gaze(
    samples: Iterable[GazeSample],
    clip_start_us: int,
    clip_end_us: int,
    grid_us: int = GAZE_GRID_US,
    max_interpolation_gap_us: int = MAX_GAZE_GAP_US,
) -> list[GazeSample]:
    """Evaluate session gaze on the clip grid and emit clip-relative timestamps."""
    if grid_us <= 0 or max_interpolation_gap_us <= 0:
        raise ValueError("sampling intervals must be positive")
    if clip_end_us <= clip_start_us:
        raise ValueError("clip_end_us must be after clip_start_us")
    ordered = sorted(samples, key=lambda sample: sample.time_us)
    return [
        _resample_one(ordered, clip_start_us + offset, offset, max_interpolation_gap_us)
        for offset in range(0, clip_end_us - clip_start_us, grid_us)
    ]


def gaze_payload(samples: Sequence[GazeSample]) -> dict[str, Any]:
    """Serialize the clip grid in protocol v1, dropping local diagnostics."""
    wire_samples = []
    if any(sample.valid for sample in samples):
        for sample in samples:
            row = asdict(sample)
            del row["reason"]
            wire_samples.append(row)
    return {"schema_version": 1, "samples": wire_samples}


def _synthetic_frames(publication_us: int) -> list[ScreenFrame]:
    # The oldest retained keyframe is at 4 s in the 25 s, 15 fps source.
    fps = 15
    frames = []
    for index in range(4 * fps, 25 * fps):
        pts_us = index * SECOND_US // fps
        if pts_us > publication_us:
            break
        duration_us = (index + 1) * SECOND_US // fps - pts_us
        frames.append(ScreenFrame(index, pts_us, index in (4 * fps, 19 * fps), duration_us=duration_us))
    return frames


def run_replay() -> dict[str, Any]:
    event = IntervalEvent(
        session_id=str(uuid4()),
        capture_epoch=0,
        event_id=str(uuid4()),
        source="replay",
        start_us=14_000_000,
        end_us=18_000_000,
        first_frame_id=112,
        last_frame_id=143,
        score=0.82,
        model_version="confusion-demo-1",
    )
    observation_us = 9_400_000
    publication_us = 19_200_000
    frames = _synthetic_frames(publication_us)
    observed = select_prior_frame(frames, observation_us, event.capture_epoch)
    publication = select_prior_frame(frames, publication_us, event.capture_epoch)
    prior = select_prior_frame(frames, observation_us - 1, event.capture_epoch)
    missing = select_prior_frame(frames, 2_000_000, event.capture_epoch)
    gap_frames = [frame for frame in frames if frame.frame_id != observed.frame_id]
    blackout = select_prior_frame(gap_frames, observation_us, event.capture_epoch)
    clip = plan_clip(event, frames)
    if not clip.ok or clip.actual_start_us is None or clip.actual_end_us is None:
        raise RuntimeError(f"synthetic clip plan failed: {clip.reason}")

    # Exercise the coordinate transform independently of the 1920×1080 fixture.
    geometry = CaptureGeometry(2560, 1440, 320, 180, 1920, 1080, 960, 540)
    rotated_geometry = replace(geometry, frame_width_px=540, frame_height_px=960, orientation_deg=90)
    mapped = map_normalized_gaze_to_frame(0.75, 0.5, geometry)
    rotated = map_normalized_gaze_to_frame(0.75, 0.5, rotated_geometry)

    session_gaze = [
        GazeSample(9_350_000, 921.2, 362.5, 109, True),
        GazeSample(9_430_000, 953.2, 394.5, 117, True),
        GazeSample(9_650_000, 900, 390, 90, True),
        GazeSample(10_050_000, 1_000, 490, 100, True),
    ]
    gaze = resample_gaze(session_gaze, clip.actual_start_us, clip.actual_end_us)
    marker_index = (observation_us - clip.actual_start_us) // GAZE_GRID_US
    marker, gap = gaze[marker_index], gaze[marker_index + 2]
    payload = gaze_payload(gaze)

    checks = {
        "clip_bounds": (clip.actual_start_us, clip.actual_end_us) == (4_000_000, 19_000_000),
        "observation_frame": observed.pts_us == observation_us,
        "publication_frame": publication.pts_us == publication_us and publication_us > event.end_us,
        "earlier_target": prior.pts_us == 9_333_333,
        "missing_history": missing.reason == "no_prior_frame",
        "screen_gap": blackout.reason == "screen_frame_gap",
        "gaze_interpolation": marker == GazeSample(5_400_000, 941.2, 382.5, 114, True),
        "gaze_gap": gap == _invalid_gaze(5_800_000, "gap_too_large"),
        "crop_scale_rotation": mapped == PixelPoint(800, 270) and rotated == PixelPoint(270, 800),
    }
    return {
        "event": {"type": "interval.finalized", "schema_version": 1, **asdict(event)},
        "timing": {
            "observed_fixation_us": observation_us,
            "event_published_us": publication_us,
            "detection_delay_us": publication_us - observation_us,
            "prior_evidence_frame": asdict(observed),
            "frame_at_publication": asdict(publication),
            "future_frame_guard_target_us": observation_us - 1,
            "future_frame_guard_example": asdict(prior),
            "screen_gap_example": asdict(blackout),
        },
        "clip": asdict(clip),
        "gaze_mapping": {
            "input_normalized": {"x": 0.75, "y": 0.5},
            "geometry": asdict(geometry),
            "frame_pixel": asdict(mapped),
            "rotated_geometry": asdict(rotated_geometry),
            "rotated_frame_pixel": asdict(rotated),
        },
        "gaze_gap_examples": {
            "short_gap_interpolated": asdict(marker),
            "large_gap_invalid": asdict(gap),
        },
        "gaze_export": {
            "grid_us": GAZE_GRID_US,
            "sample_count": len(payload["samples"]),
            "status": "available" if payload["samples"] else "unavailable",
            "wire_examples": gaze_payload([marker, gap]),
        },
        "checks": checks,
        "all_checks_pass": all(checks.values()),
    }


def _summary(result: dict[str, Any]) -> str:
    event, timing, clip = (result[key] for key in ("event", "timing", "clip"))
    observed = timing["prior_evidence_frame"]
    mapping = result["gaze_mapping"]
    mapped, rotated = mapping["frame_pixel"], mapping["rotated_frame_pixel"]
    examples = result["gaze_gap_examples"]
    gaze, gap = examples["short_gap_interpolated"], examples["large_gap_invalid"]
    return "\n".join([
        "screen-sync-lab synthetic replay",
        f"  interval [{event['start_us'] / SECOND_US:.1f}, {event['end_us'] / SECOND_US:.1f}) s "
        f"published at {timing['event_published_us'] / SECOND_US:.1f} s "
        f"({timing['detection_delay_us'] / SECOND_US:.1f} s after fixation)",
        f"  fixation selects screen frame {observed['frame_id']} at {observed['pts_us'] / SECOND_US:.1f} s",
        f"  clip [{clip['actual_start_us'] / SECOND_US:.1f}, {clip['actual_end_us'] / SECOND_US:.1f}) s "
        f"starts at keyframe {clip['decode_keyframe_id']}",
        f"  crop and scale map to ({mapped['x_px']:.0f}, {mapped['y_px']:.0f}) px "
        f"or ({rotated['x_px']:.0f}, {rotated['y_px']:.0f}) px after 90° rotation",
        f"  clip gaze at {gaze['time_us'] / SECOND_US:.1f} s is ({gaze['x_px']:.1f}, {gaze['y_px']:.1f}) px",
        f"  clip gaze at {gap['time_us'] / SECOND_US:.1f} s is invalid ({gap['reason']})",
        f"  checks: {'PASS' if result['all_checks_pass'] else 'FAIL'}",
    ])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="print machine-readable replay output")
    args = parser.parse_args()
    result = run_replay()
    print(json.dumps(result, indent=2) if args.json else _summary(result))
    return 0 if result["all_checks_pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
