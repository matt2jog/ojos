"""Load Ojos screen bundles and prepare bounded Gemini media inputs.

This module deliberately keeps the provider payload separate from the capture
payload.  It removes playback audio before a video is sent for screen analysis,
and it treats Matt's gaze points as optional attention hints rather than proof of
what a participant understood.
"""

from __future__ import annotations

import json
import math
import shutil
import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any


MAX_VIDEO_BYTES = 32 * 1024 * 1024
MAX_JSON_BYTES = 512 * 1024
MAX_FRAME_BYTES = 2 * 1024 * 1024
FRAME_QUALITY = "4"
FFMPEG_TIMEOUT_SECONDS = 30
GAZE_STEP_US = 200_000
MAX_MODEL_GAZE_SAMPLES = 16


class InputError(ValueError):
    """Raised when a capture bundle cannot safely be analysed."""


@dataclass(frozen=True)
class Clip:
    """A validated clip and the event/gaze context aligned to clip zero."""

    video: Path
    session_id: str
    event_id: str
    capture_epoch: int
    clip_start_us: int
    event_start_us: int
    event_end_us: int
    duration_us: int
    width_px: int
    height_px: int
    source: str
    gaze: tuple[dict[str, Any], ...] = ()


def _read_json(path: Path) -> Any:
    try:
        if not path.is_file() or path.stat().st_size > MAX_JSON_BYTES:
            raise InputError(f"{path.name} is missing or too large")
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError, RecursionError) as error:
        raise InputError(f"{path.name} is not valid UTF-8 JSON") from error


def _positive_int(value: Any, label: str) -> int:
    if type(value) is not int or value <= 0:
        raise InputError(f"{label} must be a positive integer")
    return value


def _uint(value: Any, label: str) -> int:
    if type(value) is not int or value < 0:
        raise InputError(f"{label} must be a nonnegative integer")
    return value


def _number(value: Any, label: str) -> float:
    if type(value) not in (int, float) or not -float("inf") < value < float("inf"):
        raise InputError(f"{label} must be a finite number")
    return float(value)


def _uuid(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise InputError(f"{label} must be a UUID")
    try:
        parsed = uuid.UUID(value)
    except ValueError as error:
        raise InputError(f"{label} must be a UUID") from error
    return str(parsed)


def _video_info(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise InputError(f"{path.name} is missing")
    try:
        size = path.stat().st_size
    except OSError as error:
        raise InputError(f"cannot inspect {path.name}") from error
    if size <= 0 or size > MAX_VIDEO_BYTES:
        raise InputError(f"{path.name} must be between 1 byte and {MAX_VIDEO_BYTES} bytes")
    if shutil.which("ffprobe") is None:
        raise InputError("ffprobe is required to inspect screen video")
    try:
        raw = subprocess.check_output(
            [
                "ffprobe", "-v", "error", "-show_streams", "-show_format",
                "-of", "json", str(path),
            ],
            stderr=subprocess.STDOUT,
            timeout=FFMPEG_TIMEOUT_SECONDS,
        )
        info = json.loads(raw)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise InputError(f"{path.name} is not a readable MP4") from error
    formats = info.get("format", {}).get("format_name", "").split(",")
    if "mp4" not in formats:
        raise InputError(f"{path.name} is not an MP4")
    streams = [stream for stream in info.get("streams", []) if stream.get("codec_type") == "video"]
    if not streams:
        raise InputError(f"{path.name} has no video stream")
    stream = streams[0]
    try:
        width = _positive_int(stream.get("width"), "video width")
        height = _positive_int(stream.get("height"), "video height")
        duration = float(stream.get("duration") or info.get("format", {}).get("duration"))
    except (TypeError, ValueError) as error:
        raise InputError(f"{path.name} has invalid video metadata") from error
    if not math.isfinite(duration) or duration <= 0:
        raise InputError(f"{path.name} has no positive duration")
    return {"width": width, "height": height, "duration_us": round(duration * 1_000_000)}


def _check_video_against_manifest(path: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    info = _video_info(path)
    for key, actual in (("viewport_width_px", info["width"]), ("viewport_height_px", info["height"])):
        if manifest[key] != actual:
            raise InputError(f"{path.name} geometry does not match manifest {key}")
    expected = manifest["clip_end_us"] - manifest["clip_start_us"]
    if abs(info["duration_us"] - expected) > 100_000:
        raise InputError(f"{path.name} duration does not match the manifest clip bounds")
    return info


def _validate_gaze_grid(value: Any, *, duration_us: int, width: int, height: int, status: str) -> tuple[dict[str, Any], ...]:
    if not isinstance(value, dict) or type(value.get("schema_version")) is not int or value["schema_version"] not in (1, 2) or not isinstance(value.get("samples"), list):
        raise InputError("gaze.json must contain schema_version 1 or 2 and samples")
    samples = value["samples"]
    if status not in ("available", "unavailable"):
        raise InputError("gaze_status must be available or unavailable")
    version = value["schema_version"]
    if version == 2:
        if value.get("timebase") != "clip_relative_us" or _positive_int(value.get("step_us"), "gaze step_us") != GAZE_STEP_US:
            raise InputError("v2 gaze must use the clip-relative 200000 µs grid")
        if (_positive_int(value.get("viewport_width_px"), "gaze width"),
                _positive_int(value.get("viewport_height_px"), "gaze height")) != (width, height):
            raise InputError("v2 gaze geometry does not match the encoded viewport")
    elif status == "unavailable":
        if samples:
            raise InputError("unavailable gaze must have an empty samples array")
        return ()
    if len(samples) != (duration_us + GAZE_STEP_US - 1) // GAZE_STEP_US:
        raise InputError("gaze samples must cover the 200000 µs clip grid")
    valid: list[dict[str, Any]] = []
    for index, sample in enumerate(samples):
        if not isinstance(sample, dict):
            raise InputError(f"gaze sample {index} is not an object")
        time_us = _uint(sample.get("time_us"), f"gaze sample {index} time_us")
        if time_us != index * GAZE_STEP_US:
            raise InputError(f"gaze sample {index} is off the clip grid")
        if version == 2:
            fused = _fused_gaze(sample, width, height)
            if fused is not None:
                valid.append(fused)
            continue
        required = {"time_us", "x_px", "y_px", "uncertainty_radius_px", "valid"}
        if set(sample) != required:
            raise InputError(f"gaze sample {index} has unexpected fields")
        if type(sample["valid"]) is not bool:
            raise InputError(f"gaze sample {index} requires a boolean validity flag")
        if not sample["valid"]:
            if any(sample[key] is not None for key in ("x_px", "y_px", "uncertainty_radius_px")):
                raise InputError(f"invalid gaze sample {index} requires null coordinates and uncertainty")
            continue
        x, y, radius = (_number(sample[field], f"gaze sample {index} {field}") for field in ("x_px", "y_px", "uncertainty_radius_px"))
        if not (0 <= x < width and 0 <= y < height and radius >= 0):
            raise InputError(f"gaze sample {index} is outside the encoded viewport")
        valid.append({"time_us": time_us, "x_px": x, "y_px": y, "uncertainty_radius_px": radius, "valid": True})
    if bool(valid) != (status == "available"):
        raise InputError("gaze_status does not match the usable gaze samples")
    return tuple(valid)


def _fused_gaze(sample: dict[str, Any], width: int, height: int) -> dict[str, Any] | None:
    """Validate the fused region and preserve both trackers’ estimates."""
    mode = sample.get("fusion_mode")
    box = sample.get("maxbox")
    if mode == "unavailable":
        if any(field not in sample or sample[field] is not None for field in ("average_x", "average_y", "maxbox")):
            raise InputError("unavailable v2 gaze requires a null fused point and box")
        return None
    if mode not in ("paired", "model1_only", "model2_only") or not isinstance(box, dict):
        raise InputError("v2 gaze requires a supported fusion mode and viewport box")
    x = _number(sample.get("average_x"), "fused gaze x")
    y = _number(sample.get("average_y"), "fused gaze y")
    left, top, w, h = (_number(box.get(key), f"gaze box {key}") for key in ("x", "y", "w", "h"))
    right, bottom = left + w, top + h
    # The exporter computes widths by subtraction. Allow for rounding when adding them back.
    epsilon = 1e-6
    if not (0 <= x < width and 0 <= y < height and w >= 0 and h >= 0
            and 0 <= left <= x + epsilon and x - epsilon <= right <= width + epsilon
            and 0 <= top <= y + epsilon and y - epsilon <= bottom <= height + epsilon):
        raise InputError("v2 fused gaze point or box is outside its encoded region")
    radius = math.hypot(max(x - left, right - x), max(y - top, bottom - y))
    coordinates = {}
    for tracker in ("model1", "model2"):
        x_key, y_key = f"x_{tracker}", f"y_{tracker}"
        raw_x, raw_y = sample.get(x_key), sample.get(y_key)
        if raw_x is not None or raw_y is not None:
            raw_x, raw_y = _number(raw_x, x_key), _number(raw_y, y_key)
            if not (0 <= raw_x < width and 0 <= raw_y < height):
                raise InputError("Individual gaze estimate is outside the viewport")
        coordinates.update({x_key: raw_x, y_key: raw_y})
    confidence = sample.get("confidence")
    if confidence is not None and not 0 <= _number(confidence, "confusion confidence") <= 1:
        raise InputError("Confusion confidence is outside 0–1")
    return {"time_us": sample["time_us"], "x_px": x, "y_px": y, "uncertainty_radius_px": radius,
            "average_x": x, "average_y": y, **coordinates, "confidence": confidence,
            "valid": True, "fusion_mode": mode, "maxbox": {"x": left, "y": top, "w": w, "h": h}}


def load_bundle(folder: Path) -> Clip:
    """Load a v1 manifest, a v1 or v2 gaze sidecar, and the encoded video."""

    folder = Path(folder).expanduser().resolve()
    manifest = _read_json(folder / "manifest.json")
    if not isinstance(manifest, dict) or type(manifest.get("schema_version")) is not int or manifest["schema_version"] != 1:
        raise InputError("manifest.json must use schema_version 1")
    session_id = _uuid(manifest.get("session_id"), "session_id")
    event_id = _uuid(manifest.get("event_id"), "event_id")
    epoch = _uint(manifest.get("capture_epoch"), "capture_epoch")
    source = manifest.get("source")
    if source not in ("live", "replay", "manual"):
        raise InputError("manifest source must be live, replay or manual")
    if manifest.get("audio_status") not in ("present", "unavailable"):
        raise InputError("manifest audio_status must be present or unavailable")
    clip_start = _uint(manifest.get("clip_start_us"), "clip_start_us")
    clip_end = _uint(manifest.get("clip_end_us"), "clip_end_us")
    event_start = _uint(manifest.get("event_start_us"), "event_start_us")
    event_end = _uint(manifest.get("event_end_us"), "event_end_us")
    if clip_end <= clip_start or event_end <= event_start:
        raise InputError("clip and event bounds must be positive intervals")
    if max(clip_start, event_start) >= min(clip_end, event_end):
        raise InputError("clip and event do not overlap")
    width = _positive_int(manifest.get("viewport_width_px"), "viewport_width_px")
    height = _positive_int(manifest.get("viewport_height_px"), "viewport_height_px")
    video = folder / "video.mp4"
    info = _check_video_against_manifest(video, {**manifest, "viewport_width_px": width, "viewport_height_px": height})
    duration_us = clip_end - clip_start
    gaze = _validate_gaze_grid(_read_json(folder / "gaze.json"), duration_us=duration_us, width=width, height=height, status=manifest.get("gaze_status"))
    local_start = max(clip_start, event_start) - clip_start
    local_end = min(clip_end, event_end) - clip_start
    if info["duration_us"] < local_end - 100_000:
        raise InputError("video duration is shorter than the event bounds")
    return Clip(video, session_id, event_id, epoch, clip_start, local_start, local_end, duration_us, width, height, source, gaze)


def _frame_times(clip: Clip) -> list[tuple[int, int]]:
    try:
        raw = subprocess.check_output(
            [
                "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_frames",
                "-show_entries", "frame=best_effort_timestamp_time:format=start_time", "-of", "json", str(clip.video),
            ],
            stderr=subprocess.STDOUT,
            timeout=FFMPEG_TIMEOUT_SECONDS,
        )
        data = json.loads(raw)
        origin = float(data.get("format", {}).get("start_time", 0))
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        raise InputError("could not inspect decoded frame timestamps") from error
    times = []
    for index, frame in enumerate(data.get("frames", [])):
        try:
            seconds = float(frame["best_effort_timestamp_time"]) - origin
        except (KeyError, ValueError):
            continue
        if math.isfinite(seconds):
            timestamp = round(seconds * 1_000_000)
            if 0 <= timestamp < clip.duration_us:
                times.append((index, timestamp))
    if not times:
        raise InputError("video has no decoded frame timestamps")
    return times


def _run_ffmpeg(args: list[str], failure: str) -> None:
    try:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-nostdin", "-y", *args],
            check=True, capture_output=True, timeout=FFMPEG_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as error:
        raise InputError(failure) from error


def _extract_still(clip: Clip, target: int, workspace: Path) -> tuple[int, bytes]:
    timeline = _frame_times(clip)
    # Selecting by decoded index keeps the frame visible at the target on VFR input.
    index, timestamp = next((frame for frame in reversed(timeline) if frame[1] <= target), timeline[0])
    file = workspace / "frame.jpg"
    _run_ffmpeg([
        "-i", str(clip.video), "-map", "0:v:0", "-vf", f"select=eq(n\\,{index})", "-fps_mode", "passthrough",
        "-frames:v", "1", "-q:v", FRAME_QUALITY, str(file),
    ], "could not decode the requested still")
    if not file.is_file() or not 0 < file.stat().st_size <= MAX_FRAME_BYTES:
        raise InputError("decoded frame is missing or oversized")
    return timestamp, file.read_bytes()


def _still_target(clip: Clip) -> int:
    event_middle = (clip.event_start_us + clip.event_end_us) // 2
    in_event = [sample for sample in clip.gaze if clip.event_start_us <= sample["time_us"] < clip.event_end_us]
    if in_event:
        focus = min(in_event, key=lambda sample: (
            sample["uncertainty_radius_px"] is None,
            sample["uncertainty_radius_px"] or 0,
            abs(sample["time_us"] - event_middle),
        ))
        return focus["time_us"]
    return next((sample["time_us"] for sample in reversed(clip.gaze)
                 if clip.event_start_us - 5_000_000 <= sample["time_us"] < clip.event_start_us), event_middle)


def prepare_media(clip: Clip, *, include_audio=False) -> tuple[bytes, tuple[tuple[int, bytes], ...], tuple[dict[str, Any], ...]]:
    """Prepare the screen video, one timestamped still, and bounded gaze hints."""

    if shutil.which("ffmpeg") is None:
        raise InputError("ffmpeg is required to prepare screen media")
    with tempfile.TemporaryDirectory(prefix="ojos-media-") as directory:
        workspace = Path(directory)
        output = workspace / "screen.mp4"
        streams = ["-map", "0:v:0"]
        if include_audio:
            streams.extend(["-map", "0:a:0?"])
        _run_ffmpeg([
            "-copyts", "-start_at_zero", "-i", str(clip.video), *streams, "-c", "copy",
            "-map_metadata", "-1", "-map_chapters", "-1", "-movflags", "+faststart", str(output),
        ], "could not prepare screen media for the provider")
        if not output.is_file() or not 0 < output.stat().st_size <= MAX_VIDEO_BYTES:
            raise InputError("prepared video is empty or too large")
        video_bytes = output.read_bytes()
        still = _extract_still(clip, _still_target(clip), workspace)

    gaze = clip.gaze
    if len(gaze) > MAX_MODEL_GAZE_SAMPLES:
        last = len(gaze) - 1
        gaze = tuple(gaze[index * last // (MAX_MODEL_GAZE_SAMPLES - 1)] for index in range(MAX_MODEL_GAZE_SAMPLES))
    return video_bytes, (still,), gaze
