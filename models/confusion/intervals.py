"""Session-clock state machine for schema version 1 interval events."""

import math
from dataclasses import dataclass
from uuid import UUID, uuid4

WARMUP_US = 4_000_000
SMOOTH_US = 350_000
CONFIRM_US = 1_000_000
HARD_CAP_US = 8_000_000
COOLDOWN_US = 15_000_000
LOSS_US = 500_000
HIGH = 0.70
LOW = 0.40


@dataclass
class Run:
    time_us: int
    frame_id: int
    peak: float


class Intervals:
    def __init__(self, session_id, model_version, source, capture_epoch=0):
        self.session_id = str(UUID(str(session_id)))
        if source not in ("live", "replay"):
            raise ValueError("Unknown source")
        self.model_version = model_version
        self.source = source
        self.capture_epoch = capture_epoch
        self.last_time = self.last_frame = None
        self.published_us = None
        self.reset_signal()

    def start_epoch(self, capture_epoch):
        if capture_epoch <= self.capture_epoch:
            raise ValueError("Capture epoch must increase")
        self.capture_epoch = capture_epoch
        self.last_frame = None
        self.reset_signal()

    def reset_signal(self):
        self.warm_us = 0
        self.smoothed = None
        self.last_usable = None
        self.previous_usable = False
        self.high = self.active = None
        self.low_us = self.before_low = self.last_contributing = None

    def publish(self, end_us, last_frame_id, time_us):
        event = {
            "type": "interval.finalized", "schema_version": 1, "session_id": self.session_id,
            "capture_epoch": self.capture_epoch, "event_id": str(uuid4()), "source": self.source,
            "start_us": self.active.time_us, "end_us": end_us,
            "first_frame_id": self.active.frame_id, "last_frame_id": last_frame_id,
            "score": self.active.peak, "model_version": self.model_version,
        }
        self.published_us = time_us
        self.active = self.high = None
        return event

    def step(self, time_us, frame_id, probability, *, reset=False):
        if (time_us < 0 or frame_id < 0 or
                (self.last_time is not None and time_us <= self.last_time) or
                (self.last_frame is not None and frame_id <= self.last_frame)):
            raise ValueError("Time and frame IDs must increase on their respective timelines")
        self.last_time, self.last_frame = time_us, frame_id
        lost = self.last_usable is not None and time_us - self.last_usable >= LOSS_US
        if reset or lost:
            self.reset_signal()
        if probability is None:
            self.previous_usable = False
            self.high = self.low_us = None
            if self.active and time_us >= self.active.time_us + HARD_CAP_US:
                return self.publish(self.active.time_us + HARD_CAP_US, self.last_contributing, time_us)
            return None
        if not math.isfinite(probability) or not 0 <= probability <= 1:
            raise ValueError("Invalid confusion probability")

        if self.last_usable is None:
            self.smoothed = probability
        else:
            elapsed = time_us - self.last_usable
            self.smoothed += -math.expm1(-elapsed / SMOOTH_US) * (probability - self.smoothed)
            if self.previous_usable:
                self.warm_us += elapsed
        self.last_usable = time_us
        self.previous_usable = True
        score = self.smoothed

        if score > LOW:
            self.low_us = None
        elif self.low_us is None:
            self.low_us = time_us
            self.before_low = self.last_contributing
        low_confirmed = self.low_us is not None and time_us - self.low_us >= CONFIRM_US
        if self.active:
            deadline = self.active.time_us + HARD_CAP_US
            if low_confirmed and self.low_us + CONFIRM_US <= deadline:
                return self.publish(self.low_us, self.before_low, time_us)
            if time_us >= deadline:
                return self.publish(deadline, self.last_contributing, time_us)
            self.active.peak = max(self.active.peak, score)
            self.last_contributing = frame_id
            return None

        self.last_contributing = frame_id
        if self.published_us is not None:
            if low_confirmed and time_us - self.published_us >= COOLDOWN_US:
                self.published_us = None
            return None
        if self.warm_us < WARMUP_US or score < HIGH:
            self.high = None
            return None
        if self.high is None:
            self.high = Run(time_us, frame_id, score)
        self.high.peak = max(self.high.peak, score)
        if time_us - self.high.time_us >= CONFIRM_US:
            self.active, self.high = self.high, None
        return None
