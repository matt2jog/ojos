"""Serve the public JPEG round-trip probe over its SSH stdin and stdout."""
import argparse
import json
from pathlib import Path
import struct
import sys
from time import perf_counter

import cv2
import numpy as np
import torch

from bench import Inference, ZERO_DISTORTION

HEADER = struct.Struct(">I")
MAX_JPEG_BYTES = 8 * 1024 * 1024


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--face-model", type=Path, required=True)
    parser.add_argument("--landmarker", type=Path, required=True)
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    args = parser.parse_args()
    args.height = None
    args.hfov = 60.
    if args.device == "cuda" and not torch.cuda.is_available():
        parser.error("CUDA is unavailable")
    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    cv2.setNumThreads(1)
    model = Inference(args, video=False)
    model.warmup()
    print(json.dumps({"ready": True}), flush=True)
    source = sys.stdin.buffer
    while header := source.read(HEADER.size):
        size, = HEADER.unpack(header)
        if size == 0:
            return
        if size > MAX_JPEG_BYTES:
            raise ValueError("JPEG request is too large")
        value = source.read(size)
        if len(value) != size:
            raise EOFError("Incomplete JPEG request")
        started = perf_counter()
        rgb = cv2.imdecode(np.frombuffer(value, dtype=np.uint8), cv2.IMREAD_COLOR_RGB)
        if rgb is None:
            raise ValueError("Invalid JPEG")
        record = model.step(rgb, None, ZERO_DISTORTION)
        print(json.dumps({"service_ms": (perf_counter() - started) * 1000,
                          "model_ms": record["stage_ms"].get("model", 0),
                          "observed": "plane" in record}), flush=True)


if __name__ == "__main__":
    main()
