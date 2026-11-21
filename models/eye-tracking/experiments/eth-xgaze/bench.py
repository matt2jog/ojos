"""Replay the official ETH-XGaze checkpoint with Ojos's MediaPipe face detector."""
import argparse
from collections import Counter
import hashlib
import io
import json
import math
import os
from pathlib import Path
from time import perf_counter
from zipfile import ZipFile

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("OMP_NUM_THREADS", "2")

import cv2
import mediapipe as mp
import numpy as np
from scipy.io import loadmat
import torch
from torch import nn
from torchvision.models import resnet50

CHECKPOINT_SHA = "f27b06dc22eb9c966a418f130b9f0df5083f81b44fc721197af5f0da8baeffd3"
FACE_MODEL_SHA = "15075125e5bb5573d5719cf15f88b137ecc9f4f135e833841fa545824791f964"
LANDMARKER_SHA = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"
NORM_SIZE = 224
NORM_CAMERA = np.array([[960., 0, 112.], [0, 960., 112.], [0, 0, 1.]])
MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)
POSE_LANDMARKS = (33, 133, 362, 263, 98, 327)
EYE_LANDMARKS = ((33, 133, 159, 145, 468), (362, 263, 386, 374, 473))
IRIS_LANDMARKS = tuple(sorted(set(sum(EYE_LANDMARKS, ()))))
FIT_FACE_POINTS = [20, 23, 26, 29, 15, 19]
ZERO_DISTORTION = np.zeros(5)


class GazeModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.gaze_network = resnet50(weights=None)
        self.gaze_fc = nn.Sequential(nn.Linear(2048, 2))

    def forward(self, image):
        x = self.gaze_network
        # The official ResNet checkpoints retain the unused ImageNet fc.
        features = x.maxpool(x.relu(x.bn1(x.conv1(image))))
        features = x.layer4(x.layer3(x.layer2(x.layer1(features))))
        return self.gaze_fc(x.avgpool(features).flatten(1))


def checked(path, expected):
    with path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != expected:
        raise ValueError(f"{path.name} SHA-256 mismatch: {digest}")
    return path


def load_model(path, device):
    checkpoint = torch.load(checked(path, CHECKPOINT_SHA), map_location="cpu", weights_only=True)
    network = GazeModel()
    network.load_state_dict(checkpoint["model_state"], strict=True)
    return network.to(device).eval()


def norm_and_pose(rgb, points, model_points, camera, distortion):
    image_points = np.ascontiguousarray(points[list(POSE_LANDMARKS)])
    obj = np.ascontiguousarray(model_points)
    ok, rotation, shift = cv2.solvePnP(obj, image_points, camera, distortion, flags=cv2.SOLVEPNP_EPNP)
    if not ok:
        return None
    ok, rotation, shift = cv2.solvePnP(
        obj, image_points, camera, distortion, rotation, shift, True, cv2.SOLVEPNP_ITERATIVE
    )
    if not ok or not np.isfinite(rotation).all() or not np.isfinite(shift).all():
        return None
    head = cv2.Rodrigues(rotation)[0]
    posed = (head @ obj.T).T + shift.reshape(3)
    face = (posed[:4].mean(axis=0) + posed[4:].mean(axis=0)) / 2
    distance = np.linalg.norm(face)
    if face[2] <= 0 or distance < 1e-8:
        return None
    forward = face / distance
    down = np.cross(forward, head[:, 0])
    norm = np.linalg.norm(down)
    if norm < 1e-8:
        return None
    down /= norm
    view_rotation = np.vstack([np.cross(down, forward), down, forward])
    transform = NORM_CAMERA @ np.diag([1., 1., 600. / distance]) @ view_rotation @ np.linalg.inv(camera)
    # solvePnP sees original distorted landmarks. Remove distortion before the homography.
    if np.any(distortion):
        rgb = cv2.undistort(rgb, camera, distortion)
    crop = cv2.warpPerspective(rgb, transform, (NORM_SIZE, NORM_SIZE))
    return crop, view_rotation, face


def estimated_camera(width, height, hfov):
    focal = width / (2 * math.tan(math.radians(hfov / 2)))
    return np.array([[focal, 0, (width - 1) / 2], [0, focal, (height - 1) / 2], [0, 0, 1]])


def resize_camera(camera, width, height, new_width, new_height):
    sx, sy = new_width / width, new_height / height
    image_scale = np.array([[sx, 0, (sx - 1) / 2], [0, sy, (sy - 1) / 2], [0, 0, 1]])
    return image_scale @ camera


def eye_acceptance(points):
    for outer, inner, upper, lower, _ in EYE_LANDMARKS:
        x, y = points[inner] - points[outer]
        squared_size = x * x + y * y
        if squared_size < 49:
            return "low_eye_quality"
        lid_x, lid_y = points[lower] - points[upper]
        if (lid_y * x - lid_x * y) / squared_size < 0.09:
            return "blink"
    return None


def camera_projection(angles, view_rotation, face):
    pitch, yaw = angles
    # The learned convention has +Z at (0,0), while the look ray points toward -Z.
    ray = -(view_rotation.T @ [math.cos(pitch) * math.sin(yaw), math.sin(pitch),
                               math.cos(pitch) * math.cos(yaw)])
    if not np.isfinite(ray).all() or ray[2] >= -0.1:
        return None
    slopes = -ray[:2] / ray[2]
    plane = face[:2] + ray[:2] * (-face[2] / ray[2])
    return slopes.tolist(), plane.tolist()


class Inference:
    def __init__(self, args, video):
        self.device = torch.device(args.device)
        self.model = load_model(args.checkpoint, self.device)
        self.points = np.loadtxt(checked(args.face_model, FACE_MODEL_SHA))[FIT_FACE_POINTS]
        vision = mp.tasks.vision
        self.detector = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(checked(args.landmarker, LANDMARKER_SHA)),
                                              delegate=mp.tasks.BaseOptions.Delegate.CPU),
            running_mode=vision.RunningMode.VIDEO if video else vision.RunningMode.IMAGE,
            num_faces=2, min_face_detection_confidence=0.6, min_face_presence_confidence=0.6,
            min_tracking_confidence=0.6, output_facial_transformation_matrixes=True,
        ))
        self.video = video
        self.output_height = args.height
        self.hfov = args.hfov

    @torch.inference_mode()
    def warmup(self):
        value = torch.zeros((1, 3, NORM_SIZE, NORM_SIZE), device=self.device)
        for _ in range(8):
            output = self.model(value)
        if not torch.isfinite(output).all().item():
            raise RuntimeError("Nonfinite warm-up result")

    @torch.inference_mode()
    def step(self, rgb, camera, distortion, time_us=None):
        started = perf_counter()
        height, width = rgb.shape[:2]
        if camera is None:
            camera = estimated_camera(width, height, self.hfov)
        if self.output_height and height != self.output_height:
            new_width = round(width * self.output_height / height)
            rgb = cv2.resize(rgb, (new_width, self.output_height), interpolation=cv2.INTER_AREA)
            camera = resize_camera(camera, width, height, new_width, self.output_height)
            height, width = rgb.shape[:2]
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        prepared = perf_counter()
        landmarks = (self.detector.detect_for_video(image, time_us // 1000) if self.video
                     else self.detector.detect(image))
        detected = perf_counter()
        faces = len(landmarks.face_landmarks)
        record = {"faces": faces, "camera": [width, height],
                  "stage_ms": {"frame": (prepared - started) * 1000, "landmarks": (detected - prepared) * 1000}}
        if faces != 1:
            record["reason"] = "tracking_lost" if faces == 0 else "ambiguous_face"
            return record
        point_map = landmarks.face_landmarks[0]
        points = np.array([(point.x, point.y) for point in point_map])
        record["landmarks"] = {point: points[point].tolist() for point in IRIS_LANDMARKS}
        if landmarks.facial_transformation_matrixes:
            record["matrix"] = landmarks.facial_transformation_matrixes[0].flatten(order="F").tolist()
        points *= [width, height]
        reason = eye_acceptance(points)
        if reason:
            record["reason"] = reason
            return record
        normalized = norm_and_pose(rgb, points, self.points, camera, distortion)
        if normalized is None:
            record["reason"] = "pose_failure"
            return record
        crop, view_rotation, face = normalized
        rgb_tensor = torch.from_numpy(np.ascontiguousarray(((crop / np.float32(255) - MEAN) / STD)
                                                           .transpose(2, 0, 1))).unsqueeze(0)
        pre_inference = perf_counter()
        # The host readback synchronizes CUDA and measures the batch-one model plus transfers.
        angles = self.model(rgb_tensor.to(self.device))[0].cpu().numpy()
        inferred = perf_counter()
        projection = camera_projection(angles, view_rotation, face)
        record["stage_ms"].update(
            geometry=(pre_inference - detected) * 1000, model=(inferred - pre_inference) * 1000,
            post=(perf_counter() - inferred) * 1000,
        )
        if projection is None:
            record["reason"] = "ray_outside_geometry"
        else:
            record["slopes"], record["plane"] = projection
        return record


def public_inputs(args):
    with ZipFile(args.archive) as archive:
        for person in ["p13", "p14"]:
            base = f"Data/{person}/"
            calibration = loadmat(io.BytesIO(archive.read(base + "Calibration/Camera.mat")))
            labels = {}
            for entry in archive.read(base + person + ".txt").decode().splitlines():
                name, x, y, *_ = entry.split()
                labels[name] = [float(x), float(y)]
            screen = loadmat(io.BytesIO(archive.read(base + "Calibration/screenSize.mat")))
            size = [int(screen[axis + "_pixel"].item()) for axis in ("width", "height")]
            with (args.match / (person + ".jsonl")).open() as selection:
                for line in selection:
                    name = json.loads(line)["image"]
                    buffer = np.frombuffer(archive.read(base + name), dtype=np.uint8)
                    rgb = cv2.imdecode(buffer, cv2.IMREAD_COLOR_RGB)
                    if rgb is None:
                        raise ValueError(f"Invalid image {person}/{name}")
                    yield rgb, calibration["cameraMatrix"], calibration["distCoeffs"], {
                        "person": person, "image": name, "target": labels[name], "screen": size,
                    }


def replay_inputs(args):
    import av
    index = json.loads(args.index.read_text(encoding="utf8"))
    start, stop = index["windows"][args.window]
    if args.duration:
        stop = min(stop, start + round(args.duration * 1_000_000))
    tick = None
    period = 1_000_000 / args.rate
    # Match the same decoded source timestamps and forward-only deadline scheduler.
    with av.open(str(args.video)) as container:
        origin = None
        for frame in container.decode(video=0):
            if frame.pts is None:
                continue
            stamp = round(frame.pts * frame.time_base * 1_000_000)
            if origin is None:
                origin = stamp
            time_us = stamp - origin
            if time_us >= stop:
                break
            if time_us < start:
                continue
            if tick is None:
                tick = float(time_us)
            if time_us + 1e-5 < tick:
                continue
            tick += (int((time_us - tick + 1e-5) // period) + 1) * period
            yield frame.to_ndarray(format="rgb24"), None, ZERO_DISTORTION, {"time": time_us}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--face-model", type=Path, required=True)
    parser.add_argument("--landmarker", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", default="cpu", choices=["cuda", "cpu"])
    parser.add_argument("--height", type=int)
    parser.add_argument("--hfov", type=float, default=60.)
    parser.add_argument("--threads", type=int, default=2)
    inputs = parser.add_subparsers(dest="input", required=True)
    public = inputs.add_parser("public")
    public.add_argument("--archive", type=Path, required=True)
    public.add_argument("--match", type=Path, required=True)
    replay = inputs.add_parser("replay")
    replay.add_argument("--video", type=Path, required=True)
    replay.add_argument("--index", type=Path, required=True)
    replay.add_argument("--window", choices=["calibration", "reasoning"], default="calibration")
    replay.add_argument("--rate", type=int, default=20)
    replay.add_argument("--duration", type=float)
    args = parser.parse_args()
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA requested and unavailable")
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    cv2.setNumThreads(1)
    core = Inference(args, args.input == "replay")
    core.warmup()
    started = perf_counter()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    counts = Counter()
    temp = args.output.with_suffix(args.output.suffix + ".part")
    source = public_inputs(args) if args.input == "public" else replay_inputs(args)
    with temp.open("w", encoding="utf8") as output:
        for index, (rgb, intrinsics, distortion, identity) in enumerate(source, 1):
            result = core.step(rgb, intrinsics, distortion, identity.get("time"))
            record = identity | result
            counts[record.get("reason", "usable")] += 1
            output.write(json.dumps(record, separators=(",", ":"), allow_nan=False) + "\n")
            if index % 250 == 0:
                output.flush()
                print(f"{index} samples in {perf_counter() - started:.1f}s, {dict(counts)}", flush=True)
    temp.replace(args.output)
    timing = {"wall_s": perf_counter() - started, "counts": dict(counts), "device": args.device,
              "torch": torch.__version__, "height": args.height}
    args.output.with_suffix(".timing.json").write_text(json.dumps(timing, indent=2) + "\n")
    print(json.dumps(timing), flush=True)


if __name__ == "__main__":
    main()
