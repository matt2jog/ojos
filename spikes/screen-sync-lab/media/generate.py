#!/usr/bin/env python3
"""Generate and verify a local, synthetic v1 screen replay fixture."""

from __future__ import annotations

import argparse
import array
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid


SECOND_US = 1_000_000
WIDTH, HEIGHT = 1920, 1080
FPS = 15
SOURCE_SECONDS = 25
EVENT_START, EVENT_END = 14, 18
CLIP_START, CLIP_END = 4, 19
FLASH_START_FRAME, FLASH_END_FRAME = 141, 147
GAZE_TIME_US = FLASH_START_FRAME * SECOND_US // FPS
GAZE_X, GAZE_Y = 941.2, 382.5
AUDIO_RATE, TONE_HZ = 48_000, 880
GRID_STEP_US = 200_000

# Draw at half-resolution and enlarge 2× to keep the bitmap strokes sharp.
CANVAS_W, CANVAS_H = WIDTH // 2, HEIGHT // 2
MARK_X, MARK_Y = int(GAZE_X / 2), int(GAZE_Y / 2)

# Fixed 5×7 glyphs avoid system fonts and optional FFmpeg text filters.
# Each hexadecimal pair encodes one five-pixel scanline, top to bottom.
GLYPHS = {line[0]: bytes.fromhex(line[2:]) for line in """A 0e11111f111111
B 1e11111e11111e
C 0f10101010100f
D 1e11111111111e
E 1f10101e10101f
F 1f10101e101010
G 0f10101311110f
H 1111111f111111
I 0e04040404040e
J 0702020212120c
K 11121418141211
L 1010101010101f
M 111b1515111111
N 11191513111111
O 0e11111111110e
P 1e11111e101010
Q 0e11111115120d
R 1e11111e141211
S 0f10100e01011e
T 1f040404040404
U 1111111111110e
V 11111111110a04
W 11111115151b11
X 11110a040a1111
Y 11110a04040404
Z 1f01020408101f
a 00000e010f110f
b 10101e1111111e
c 00000f1010100f
d 01010f1111110f
e 00000e111f100f
f 0609081c080808
g 00000f11110f011e
h 10101e11111111
i 04000c0404040e
j 020006020202120c
k 10101214181412
l 0c04040404040e
m 00001a15151515
n 00001e11111111
o 00000e1111110e
p 00001e11111e1010
q 00000f11110f0101
r 00001619101010
s 00000f100e011e
t 08081c08080906
u 0000111111130d
v 00001111110a04
w 0000111115150a
x 0000110a040a11
y 00001111110f011e
z 00001f0204081f
0 0e11131519110e
1 040c040404040e
2 0e11010204081f
3 1e01010601011e
4 02060a121f0202
5 1f101e0101110e
6 0608101e11110e
7 1f010204080808
8 0e11110e11110e
9 0e11110f01020c
. 00000000000c0c
, 000000000c0c08
: 000c0c000c0c00
? 0e110102040004
/ 01010204081010
[ 0e08080808080e
] 0e02020202020e
( 02040808080402
) 08040202020408
= 00001f001f0000
" 0a0a0a00000000
$ 040f140e051e04""".splitlines()}


def rectangle(frame: bytearray, x: int, y: int, width: int, height: int, rgb: tuple[int, int, int]) -> None:
    row = bytes(rgb) * width
    for py in range(y, y + height):
        offset = (py * CANVAS_W + x) * 3
        frame[offset:offset + len(row)] = row


def draw_text(frame: bytearray, x: int, y: int, text: str, scale: int, rgb: tuple[int, int, int]) -> None:
    for letter in text:
        if letter != " ":
            for row, bits in enumerate(GLYPHS[letter]):
                for column in range(5):
                    if bits & (1 << (4 - column)):
                        rectangle(frame, x + column * scale, y + row * scale, scale, scale, rgb)
        x += 6 * scale


def page(late: bool) -> bytearray:
    frame = bytearray(bytes((232, 239, 247)) * (CANVAS_W * CANVAS_H))
    header = (60, 38, 76) if late else (24, 41, 61)
    tint = (223, 211, 235) if late else (245, 222, 172)
    ink = (26, 36, 52)
    white = (255, 255, 255)
    rectangle(frame, 0, 0, CANVAS_W, 62, header)
    draw_text(frame, 32, 19, "OJOS / SYNTHETIC REPLAY", 3, white)
    rectangle(frame, 54, 86, 852, 405, white)
    rectangle(frame, 54, 86, 6, 405, header)
    draw_text(frame, 82, 112, "DEMO 02 / TERMINAL" if late else "DEMO 01 / PYTHON LISTS", 2, ink)
    title = "Which command shows the current directory?" if late else "Why does items[3] raise IndexError?"
    draw_text(frame, 82, 146, title, 3, ink)
    rectangle(frame, 82, 178, 794, 28, tint)
    draw_text(frame, 95, 184, "FOCUS: WORKING DIRECTORY" if late else "FOCUS: LIST INDEX 3", 2, ink)
    rectangle(frame, MARK_X - 8, MARK_Y - 8, 16, 16, header)
    rectangle(frame, 82, 232, 794, 114, header)
    if late:
        draw_text(frame, 105, 249, "$ pwd", 3, white)
        draw_text(frame, 105, 288, "/demo/workspace", 3, white)
        draw_text(frame, 82, 376, "Print the working directory.", 3, ink)
    else:
        draw_text(frame, 105, 249, 'items = ["sun", "moon", "star"]', 3, white)
        draw_text(frame, 105, 288, "print(items[3])", 3, white)
        draw_text(frame, 82, 376, "Three entries use indices 0, 1, and 2.", 3, ink)
        draw_text(frame, 82, 411, "Index 3 is outside the list.", 3, ink)
    return frame


def write_source(path: Path) -> None:
    flash_start, flash_end = FLASH_START_FRAME / FPS, FLASH_END_FRAME / FPS
    audio = (
        f"aevalsrc=0.2*sin(2*PI*{TONE_HZ}*t)*gte(t\\,{flash_start})*lt(t\\,{flash_end})"
        f":s={AUDIO_RATE}:d={SOURCE_SECONDS}"
    )
    command = [
        "ffmpeg", "-v", "error", "-nostdin", "-f", "rawvideo", "-pixel_format", "rgb24",
        "-video_size", f"{CANVAS_W}x{CANVAS_H}", "-framerate", str(FPS), "-i", "pipe:0",
        "-f", "lavfi", "-i", audio, "-vf", f"scale={WIDTH}:{HEIGHT}:flags=neighbor",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-bf", "0",
        "-g", str(SOURCE_SECONDS * FPS), "-sc_threshold", "0",
        "-force_key_frames", f"{CLIP_START},{CLIP_END}", "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart", str(path),
    ]
    normal = page(late=False)
    flash = normal.copy()
    rectangle(flash, MARK_X - 14, MARK_Y - 14, 28, 28, (255, 255, 255))
    late = page(late=True)
    with subprocess.Popen(command, stdin=subprocess.PIPE) as process:
        assert process.stdin is not None
        for index in range(SOURCE_SECONDS * FPS):
            base = normal
            if index >= CLIP_END * FPS:
                base = late
            elif FLASH_START_FRAME <= index < FLASH_END_FRAME:
                base = flash
            frame = base.copy()
            draw_text(frame, 698, 23, f"SESSION {index / FPS:06.3f} S", 2, (255, 255, 255))
            process.stdin.write(frame)
        process.stdin.close()
        if process.wait() != 0:
            raise subprocess.CalledProcessError(process.returncode, command)


def write_clip(source: Path, clip: Path) -> None:
    # Keep the video packets and trim AAC to the exact sample boundaries of the clip.
    clip_seconds = CLIP_END - CLIP_START
    audio_samples = clip_seconds * AUDIO_RATE
    subprocess.run([
        "ffmpeg", "-v", "error", "-nostdin", "-ss", str(CLIP_START), "-i", str(source),
        "-t", str(clip_seconds), "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
        "-af", f"aresample=first_pts=0,atrim=end_sample={audio_samples}",
        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(clip),
    ], check=True)


def write_protocol(directory: Path) -> None:
    session = {"schema_version": 1, "session_id": str(uuid.uuid4()), "capture_epoch": 0}
    event = {**session, "event_id": str(uuid.uuid4()), "source": "replay"}
    sample = {"x_px": GAZE_X, "y_px": GAZE_Y, "uncertainty_radius_px": 114, "valid": True}
    missing = {"x_px": None, "y_px": None, "uncertainty_radius_px": None, "valid": False}
    clip_start_us, clip_end_us = CLIP_START * SECOND_US, CLIP_END * SECOND_US
    gaze_clip_us = GAZE_TIME_US - clip_start_us
    documents = {
        "interval.json": {
            "type": "interval.finalized", **event,
            "start_us": EVENT_START * SECOND_US, "end_us": EVENT_END * SECOND_US,
            "first_frame_id": 112, "last_frame_id": 143, "score": 0.82,
            "model_version": "confusion-demo-1",
        },
        "session-gaze.json": [
            {"type": "gaze.sample", **session, "time_us": GAZE_TIME_US, **sample},
        ],
        "manifest.json": {
            **event, "event_start_us": EVENT_START * SECOND_US, "event_end_us": EVENT_END * SECOND_US,
            "clip_start_us": clip_start_us, "clip_end_us": clip_end_us,
            "viewport_width_px": WIDTH, "viewport_height_px": HEIGHT,
            "audio_status": "present", "gaze_status": "available",
        },
        "gaze.json": {
            "schema_version": 1,
            "samples": [
                {"time_us": time_us, **(sample if time_us == gaze_clip_us else missing)}
                for time_us in range(0, clip_end_us - clip_start_us, GRID_STEP_US)
            ],
        },
    }
    for filename, document in documents.items():
        (directory / filename).write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


def probe(path: Path, *options: str) -> dict:
    return json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", *options, "-of", "json", str(path),
    ]))


def video_packets(path: Path) -> list[dict]:
    return probe(
        path, "-select_streams", "v:0", "-show_packets", "-show_data_hash", "sha256",
        "-show_entries", "packet=pts_time,flags,data_hash",
    )["packets"]


def tone_windows(path: Path) -> tuple[float, float]:
    raw = subprocess.check_output([
        "ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-map", "0:a:0",
        "-ar", str(AUDIO_RATE), "-ac", "1", "-f", "s16le", "pipe:1",
    ])
    samples = array.array("h", raw)
    if sys.byteorder != "little":
        samples.byteswap()
    window = AUDIO_RATE // 100
    audible = [
        start for start in range(0, len(samples), window)
        if max(map(abs, samples[start:start + window])) > 2_500
    ]
    if not audible:
        raise ValueError(f"{path.name}: no tone detected")
    return audible[0] / AUDIO_RATE, (audible[-1] + window) / AUDIO_RATE


def flash_frames(path: Path) -> list[int]:
    patch_size = 8
    crop_x, crop_y = MARK_X * 2 - patch_size // 2, MARK_Y * 2 - patch_size // 2
    pixels = subprocess.check_output([
        "ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-map", "0:v:0",
        "-vf", f"crop={patch_size}:{patch_size}:{crop_x}:{crop_y}",
        "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1",
    ])
    patch_bytes = patch_size * patch_size
    return [
        offset // patch_bytes for offset in range(0, len(pixels), patch_bytes)
        if sum(pixels[offset:offset + patch_bytes]) > 230 * patch_bytes
    ]


def verify_media(source: Path, clip: Path) -> None:
    for path, duration, frame_offset in ((source, SOURCE_SECONDS, 0), (clip, CLIP_END - CLIP_START, CLIP_START * FPS)):
        info = probe(path, "-show_streams", "-show_format")
        video, audio = info["streams"]
        expected = ("h264", WIDTH, HEIGHT, f"{FPS}/1", duration, duration * FPS)
        actual = (
            video["codec_name"], video["width"], video["height"], video["avg_frame_rate"],
            float(video["duration"]), int(video["nb_frames"]),
        )
        if actual != expected or float(video["start_time"]) != 0:
            raise ValueError(f"{path.name}: expected {expected} at zero, got {actual}")
        if (audio["codec_name"], int(audio["sample_rate"]), audio["channels"]) != ("aac", AUDIO_RATE, 1):
            raise ValueError(f"{path.name}: expected mono AAC at {AUDIO_RATE} Hz")
        if float(audio["start_time"]) != 0 or float(audio["duration"]) != duration or float(info["format"]["duration"]) != duration:
            raise ValueError(f"{path.name}: audio or container bounds differ from video bounds")
        first, end = FLASH_START_FRAME - frame_offset, FLASH_END_FRAME - frame_offset
        if flash_frames(path) != list(range(first, end)):
            raise ValueError(f"{path.name}: flash frames do not match the expected interval")
        tone_start, tone_end = tone_windows(path)
        if abs(tone_start - first / FPS) > 0.011 or abs(tone_end - end / FPS) > 0.011:
            raise ValueError(f"{path.name}: detected tone {tone_start:.3f}–{tone_end:.3f} s differs from flash")
        print(f"{path.name}: {WIDTH}×{HEIGHT} at {FPS} fps, {duration} s, {duration * FPS} frames, mono AAC")
        print(f"  Flash [{first / FPS:.3f}, {end / FPS:.3f}) s; decoded tone [{tone_start:.3f}, {tone_end:.3f}) s")

    source_packets, clip_packets = video_packets(source), video_packets(clip)
    keyframes = [float(packet["pts_time"]) for packet in source_packets if "K" in packet["flags"]]
    if keyframes != [0, CLIP_START, CLIP_END] or "K" not in clip_packets[0]["flags"]:
        raise ValueError(f"Unexpected source keyframes or clip start: {keyframes}")
    retained = [packet for packet in source_packets if CLIP_START <= float(packet["pts_time"]) < CLIP_END]
    if [packet["data_hash"] for packet in retained] != [packet["data_hash"] for packet in clip_packets]:
        raise ValueError("Clip video packets differ from the requested half-open source range")
    for original, exported in zip(retained, clip_packets):
        if abs(float(original["pts_time"]) - float(exported["pts_time"]) - CLIP_START) > 0.000001:
            raise ValueError("Clip packet timestamps do not match the common timeline")
    print(f"  Source keyframes: {', '.join(f'{time:g} s' for time in keyframes)}")
    print(f"  All {len(retained)} video packet hashes match source interval [{CLIP_START}, {CLIP_END}) s")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, help="new output directory (default: unique temporary directory)")
    args = parser.parse_args()
    for program in ("ffmpeg", "ffprobe"):
        if shutil.which(program) is None:
            parser.error(f"{program} is required on PATH; use an FFmpeg build with libx264")

    output = args.output_dir
    if output is None:
        output = Path(tempfile.mkdtemp(prefix="ojos-replay-media-"))
    else:
        output = output.expanduser().resolve()
        try:
            output.mkdir(parents=True)
        except FileExistsError:
            parser.error(f"output directory already exists: {output}")

    with tempfile.TemporaryDirectory(dir=output) as staging_path:
        staging = Path(staging_path)
        source, clip = staging / "source.mp4", staging / "video.mp4"
        write_source(source)
        write_clip(source, clip)
        verify_media(source, clip)
        write_protocol(staging)
        for path in staging.iterdir():
            path.rename(output / path.name)
    print(f"Fixture written to {output}")


if __name__ == "__main__":
    main()
