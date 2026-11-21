"""Shared frame sampling, face tracking, alignment, and normalization."""

import hashlib
import math
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from intervals import LOSS_US

SIZE = 112
DETECTOR_SIZE = 320
MEAN = (0.485, 0.456, 0.406)
STD = (0.229, 0.224, 0.225)
YUNET_NAME = "face_detection_yunet_2023mar.onnx"
YUNET_REVISION = "3cc26e7f1014a5ee5d74a42acee58bafc9d0a310"
YUNET_URL = f"https://huggingface.co/opencv/face_detection_yunet/resolve/{YUNET_REVISION}/{YUNET_NAME}"
YUNET_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"


def normalize(rgb):
    mean = np.asarray(MEAN, dtype=np.float32)
    std = np.asarray(STD, dtype=np.float32)
    channels = (rgb.astype(np.float32) / 255 - mean) / std
    return np.moveaxis(channels, -1, -3)


class Sampler:
    """Choose the first distinct frame at or after each due source time."""

    def __init__(self, hz):
        if hz not in (4, 8, 16):
            raise ValueError("Expected a cadence of 4, 8, or 16 Hz")
        self.period_us = 1_000_000 // hz
        self.next_us = None
        self.last_us = -1
        self.skipped_ticks = 0

    def take(self, time_us):
        if time_us < 0 or time_us < self.last_us:
            raise ValueError("Frame timestamps must increase within an epoch")
        if time_us == self.last_us:
            return False
        self.last_us = time_us
        if self.next_us is None:
            self.next_us = time_us
        if time_us < self.next_us:
            return False
        elapsed_ticks = (time_us - self.next_us) // self.period_us
        self.skipped_ticks += elapsed_ticks
        self.next_us += (elapsed_ticks + 1) * self.period_us
        return True


@dataclass(frozen=True)
class Crop:
    rgb: np.ndarray | None
    reason: str
    track: int
    reset: bool = False


def overlap(first, second):
    lo = np.maximum(first[:2], second[:2])
    hi = np.minimum(first[:2] + first[2:4], second[:2] + second[2:4])
    intersection = float(np.maximum(hi - lo, 0).prod())
    return intersection / (float(first[2:4].prod() + second[2:4].prod()) - intersection)


def aligned_crop(frame, face):
    x, y, w, h = face[:4]
    eyes = face[4:8].reshape(2, 2)
    left, right = eyes[np.argsort(eyes[:, 0])]
    dx, dy = right - left
    angle = math.degrees(math.atan2(dy, dx))
    if w < 36 or h < 36 or math.hypot(dx, dy) < 0.17 * w or abs(angle) > 35:
        return None, "face_geometry"

    # Rotate around the face center and crop a square with 20% margin per side.
    center = (float(x + w / 2), float(y + h / 2))
    side = 1.4 * max(w, h)
    transform = cv2.getRotationMatrix2D(center, angle, SIZE / side)
    transform[:, 2] += (SIZE - 1) / 2 - np.array(center)
    gray_padding = np.full(frame.shape[:2], 255, dtype=np.uint8)
    visible = cv2.warpAffine(gray_padding, transform, (SIZE, SIZE), flags=cv2.INTER_NEAREST)
    if np.count_nonzero(visible) < 0.82 * visible.size:
        return None, "out_of_frame"
    bgr = cv2.warpAffine(frame, transform, (SIZE, SIZE), borderMode=cv2.BORDER_REPLICATE)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    if gray.std() < 9 or np.mean((gray < 10) | (gray > 245)) > 0.75:
        return None, "exposure"
    if cv2.Laplacian(gray, cv2.CV_32F).var() < 12:
        return None, "blur"
    return cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB), "usable"


class FacePreprocessor:
    def __init__(self, asset):
        if hashlib.sha256(Path(asset).read_bytes()).hexdigest() != YUNET_SHA256:
            raise ValueError("YuNet model checksum mismatch")
        self.detector = cv2.FaceDetectorYN.create(str(asset), "", (DETECTOR_SIZE, DETECTOR_SIZE), 0.8, 0.3, 30)
        self.clear()

    def clear(self):
        self.box = None
        self.last_usable = None
        self.track = 0

    def detect(self, frame):
        h, w = frame.shape[:2]
        scale = DETECTOR_SIZE / max(w, h)
        width, height = max(1, round(w * scale)), max(1, round(h * scale))
        x, y = (DETECTOR_SIZE - width) // 2, (DETECTOR_SIZE - height) // 2
        image = np.zeros((DETECTOR_SIZE, DETECTOR_SIZE, 3), dtype=np.uint8)
        image[y:y + height, x:x + width] = cv2.resize(frame, (width, height))
        _, faces = self.detector.detect(image)
        if faces is None:
            return []
        faces[:, [0, 4, 6, 8, 10, 12]] -= x
        faces[:, [1, 5, 7, 9, 11, 13]] -= y
        faces[:, :14:2] *= w / width
        faces[:, 1:14:2] *= h / height
        return [f for f in faces if f[2] > 0 and f[3] > 0]

    def observe(self, time_us, frame):
        reset = self.last_usable is not None and time_us - self.last_usable >= LOSS_US
        if reset:
            self.box = self.last_usable = None
            self.track += 1
        faces = self.detect(frame)
        if not faces:
            return Crop(None, "missing_face", self.track, reset)
        faces.sort(key=lambda f: float(f[2] * f[3]), reverse=True)
        if self.box is not None:
            matches = [face for face in faces if overlap(face, self.box) >= 0.28]
            if len(matches) > 1:
                return Crop(None, "ambiguous_faces", self.track, reset)
            if not matches:
                self.box = self.last_usable = None
                self.track += 1
                return Crop(None, "track_change", self.track, True)
            primary = matches[0]
        else:
            primary = faces[0]
        if any(face is not primary and face[2] * face[3] >= 0.60 * primary[2] * primary[3] for face in faces):
            return Crop(None, "ambiguous_faces", self.track, reset)
        rgb, reason = aligned_crop(frame, primary)
        if rgb is not None:
            self.box = primary[:4].copy()
            self.last_usable = time_us
        return Crop(rgb, reason, self.track, reset)
