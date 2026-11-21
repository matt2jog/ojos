"""CPU ONNX inference entry point for sampled camera frames."""

import hashlib
import json
from collections import Counter
from pathlib import Path

import numpy as np
import onnxruntime as ort

from intervals import Intervals, TriggerPolicy
from preprocess import MEAN, STD, YUNET_SHA256, FacePreprocessor, Sampler, normalize


class ConfusionRuntime:
    def __init__(self, artifact, yunet, session_id, *, capture_epoch=0, source="live", policy=TriggerPolicy()):
        artifact = Path(artifact)
        self.metadata = json.loads((artifact / "confusion.json").read_text(encoding="utf-8"))
        model = artifact / "confusion.onnx"
        if hashlib.sha256(model.read_bytes()).hexdigest() != self.metadata["onnx_sha256"]:
            raise ValueError("Confusion model checksum mismatch")
        if (self.metadata["yunet"]["sha256"] != YUNET_SHA256 or
                self.metadata["normalization"] != {"mean": list(MEAN), "std": list(STD), "divisor": 255}):
            raise ValueError("Confusion preprocessing metadata mismatch")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        self.session = ort.InferenceSession(str(model), options, providers=["CPUExecutionProvider"])
        self.face = FacePreprocessor(yunet)
        self.interval = Intervals(session_id, self.metadata["model_version"], source, capture_epoch, policy=policy)
        self._reset_capture()

    def _reset_capture(self):
        self.face.clear()
        self.sampler = Sampler(self.metadata["hz"])
        self.state = np.zeros((1, 1, 128), dtype=np.float32)
        self.counts = Counter()
        self.first_us = self.last_us = None

    def start_epoch(self, capture_epoch):
        self.interval.start_epoch(capture_epoch)
        self._reset_capture()

    def process(self, frame_bgr, time_us, frame_id):
        """Return a finalized event or None. Call from a dedicated vision worker."""
        output = self.process_sample(frame_bgr, time_us, frame_id)
        return output["interval"] if output else None

    def process_sample(self, frame_bgr, time_us, frame_id):
        """Return a score update and optional event for each processed capture frame."""
        if not self.sampler.take(time_us):
            return None
        if self.first_us is None:
            self.first_us = time_us
        self.last_us = time_us
        result = self.face.observe(time_us, frame_bgr)
        self.counts[result.reason] += 1
        score = None
        if result.reset:
            self.state.fill(0)
        if result.rgb is not None:
            frame = normalize(result.rgb)[None].copy()
            probabilities, self.state = self.session.run(None, {"frame_rgb": frame, "state_in": self.state})
            score = float(probabilities[0, 1])
        event = self.interval.step(time_us, frame_id, score, reset=result.reset)
        return {"interval": event, "sample": {
            "type": "confusion.score", "schema_version": 1,
            "session_id": self.interval.session_id, "capture_epoch": self.interval.capture_epoch,
            "time_us": time_us, "valid": score is not None, "quality": result.reason,
            "confidence_raw": score, "confidence": self.interval.smoothed if score is not None else None,
            "model_version": self.metadata["model_version"],
        }}

    def diagnostics(self):
        count = sum(self.counts.values())
        span = self.last_us - self.first_us if count > 1 else 0
        return {"sampled": count, "quality": dict(self.counts),
                "usable_face_coverage": self.counts["usable"] / count if count else None,
                "skipped_ticks": self.sampler.skipped_ticks,
                "effective_hz": (count - 1) * 1_000_000 / span if span else None}
