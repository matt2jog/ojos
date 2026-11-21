"""Local NDJSON camera worker for the desktop vision dispatcher."""

import argparse
import base64
import json
import sys
from pathlib import Path
from time import perf_counter
from uuid import UUID

import cv2
import numpy as np

MODELS = Path(__file__).resolve().parents[1]
MAX_FRAME_LINE = 8 * 1024 * 1024
ETH_ID = "eth-xgaze-resnet50-epoch24-camera-plane-ridge-v1"


def load_pipeline(args):
    cv2.setNumThreads(1)
    if args.worker == "confusion":
        sys.path.insert(0, str(MODELS / "confusion"))
        from intervals import DEMO_POLICY, TriggerPolicy
        from runtime import ConfusionRuntime

        policy = DEMO_POLICY if args.trigger_profile == "demo" else TriggerPolicy()
        runtime = ConfusionRuntime(args.artifact, args.artifact / "face_detection_yunet_2023mar.onnx",
                                   args.session_id, capture_epoch=args.capture_epoch,
                                   source=args.source, policy=policy)
        return runtime.metadata["model_version"], runtime.process_sample, runtime.interval.set_high

    sys.path.insert(0, str(MODELS / "eye-tracking/experiments/eth-xgaze"))
    import torch
    from bench import Inference, ZERO_DISTORTION

    torch.set_num_threads(2)
    torch.set_num_interop_threads(1)
    args.device, args.height = "cpu", 720
    args.checkpoint = args.artifact / "epoch_24_ckpt.pth.tar"
    args.face_model = args.artifact / "face_model.txt"
    args.landmarker = args.artifact / "face_landmarker.task"
    runtime = Inference(args, video=True)
    runtime.warmup()

    def estimate(frame, time_us, _frame_id):
        result = runtime.step(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB), None, ZERO_DISTORTION, time_us)
        return {"plane": result.get("plane"), "reason": result.get("reason"), "stage_ms": result["stage_ms"]}

    return ETH_ID, estimate, None


def emit(**record):
    print(json.dumps(record, allow_nan=False, separators=(",", ":")), flush=True)


def serve(infer, set_high=None):
    last_time = last_frame = -1
    source = sys.stdin.buffer
    while line := source.readline(MAX_FRAME_LINE + 1):
        if len(line) > MAX_FRAME_LINE:
            raise ValueError("NDJSON frame exceeds maximum size")
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            if request.get("type") == "close":
                emit(type="closed", id=request_id)
                return
            t, frame_id = request.get("time_us"), request.get("frame_id")
            if request.get("type") != "frame" or type(t) is not int or type(frame_id) is not int or (
                    t <= last_time or frame_id <= last_frame):
                raise ValueError("Expected strictly increasing frame time and ID")
            started = perf_counter()
            encoded = base64.b64decode(request["jpeg_base64"], validate=True)
            frame = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                raise ValueError("Invalid camera JPEG")
            if "trigger_high" in request:
                high = request["trigger_high"]
                if set_high is None or type(high) not in (int, float) or not 0.65 <= high <= 0.95:
                    raise ValueError("Trigger threshold must be between 0.65 and 0.95 on the confusion worker")
                set_high(high)
        except (ValueError, TypeError, KeyError, AttributeError, cv2.error) as error:
            emit(type="frame.error", id=request_id, error=str(error))
            continue
        last_time, last_frame = t, frame_id
        result = infer(frame, t, frame_id)
        emit(type="frame.done", id=request_id, time_us=t, frame_id=frame_id,
             service_ms=(perf_counter() - started) * 1000, result=result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("worker", choices=["confusion", "eth-xgaze"])
    parser.add_argument("--artifact", required=True, type=Path)
    parser.add_argument("--session-id", required=True, type=UUID)
    parser.add_argument("--capture-epoch", type=int, default=0)
    parser.add_argument("--source", choices=["live", "replay"], default="live")
    parser.add_argument("--trigger-profile", choices=["demo", "research"], default="demo")
    parser.add_argument("--hfov", type=float, default=60.)
    args = parser.parse_args()
    if args.capture_epoch < 0 or not 0 < args.hfov < 180:
        parser.error("Capture epoch and camera field of view are invalid")
    version, infer, set_high = load_pipeline(args)
    emit(type="ready", worker=args.worker, model_version=version)
    serve(infer, set_high)


if __name__ == "__main__":
    main()
