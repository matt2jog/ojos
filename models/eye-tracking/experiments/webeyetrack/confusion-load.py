"""Run the existing ONNX confusion pipeline at its configured 8 Hz during a browser replay."""
import argparse
import json
import sys
import time
from pathlib import Path

import av
import cv2

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--source", type=Path, required=True)
parser.add_argument("--recording", type=Path, required=True)
parser.add_argument("--ready", type=Path, required=True)
parser.add_argument("--stop", type=Path)
parser.add_argument("--seconds", type=float, required=True)
args = parser.parse_args()
sys.path.insert(0, str(args.source / "confusion-src"))
from runtime import ConfusionRuntime

cv2.setNumThreads(1)
artifact = args.source / "assets/devemo-gru-8hz/onnx-verified"
runtime = ConfusionRuntime(artifact, artifact / "face_detection_yunet_2023mar.onnx",
                           "36949c20-d372-48a9-94fc-645f8d7ee20d", source="replay")
frames = []
with av.open(str(args.recording / "webcam.webm")) as video:
    for frame in video.decode(video.streams.video[0]):
        if frame.time and 50 <= frame.time < 55 and len(frames) < (frame.time - 50) * 8:
            frames.append(frame.to_ndarray(format="bgr24"))
        if frame.time and frame.time >= 55:
            break
if not frames:
    raise RuntimeError("Could not load replay frames")
start = time.perf_counter()
args.ready.write_text("ready\n")
for index in range(round(args.seconds * 8)):
    if args.stop and args.stop.exists():
        break
    due = start + index / 8
    wait = due - time.perf_counter()
    if wait > 0:
        time.sleep(wait)
    runtime.process(frames[index % len(frames)], index * 125000, index)
print(json.dumps(runtime.diagnostics()), flush=True)
