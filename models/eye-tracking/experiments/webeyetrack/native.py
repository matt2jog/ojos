"""Native benchmark using the pinned upstream Keras checkpoint and geometry functions."""
import argparse
import hashlib
import importlib
import itertools
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import types
from zipfile import ZipFile

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
os.environ.setdefault("TF_NUM_INTRAOP_THREADS", "2")
os.environ.setdefault("TF_NUM_INTEROP_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

import av
import cv2
import mediapipe as mp
import numpy as np
import tensorflow as tf
from scipy.io import loadmat
import io

LANDMARKS = (33, 133, 159, 145, 468, 362, 263, 386, 374, 473)
UPSTREAM_REV = "75fbd2f5f784f2eb3a39675a8dcbf1b01c697f1c"
CHECKPOINT_SHA = "5b011cfe82466896e27b1ac3e18130117cafbc02dbc964a1ad7315f62005cc05"
TASK_SHA = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"


def check(path, sha):
    if hashlib.sha256(path.read_bytes()).hexdigest() != sha:
        raise ValueError(f"Unexpected hash for {path}")


def load_upstream(upstream):
    actual = subprocess.check_output(["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True).strip()
    if actual != UPSTREAM_REV:
        raise ValueError(f"Expected upstream {UPSTREAM_REV}")
    # Load the official geometry module directly. The package-level wrapper
    # declares mutable dataclass defaults rejected by Python 3.11 and newer.
    package = types.ModuleType("webeyetrack")
    package.__path__ = [str(upstream / "python/webeyetrack")]
    sys.modules["webeyetrack"] = package
    protocol_path = Path(package.__path__[0]) / "data_protocols.py"
    protocol = types.ModuleType("webeyetrack.data_protocols")
    protocol.__file__ = str(protocol_path)
    source = protocol_path.read_text(encoding="utf8")
    source = source.replace("norm_pog: np.ndarray = np.array([0.5, 0.5])",
                            "norm_pog: np.ndarray = field(default_factory=lambda: np.array([0.5, 0.5]))")
    sys.modules[protocol.__name__] = protocol
    exec(compile(source, protocol_path, "exec"), protocol.__dict__)
    return importlib.import_module("webeyetrack.model_based")


class Native:
    def __init__(self, upstream, video, variant):
        self.variant = variant
        self.geometry = load_upstream(upstream)
        model_dir = upstream / "python/webeyetrack/model_weights"
        model_path = model_dir / "blazegaze_mpiifacegaze.keras"
        task_path = model_dir / "face_landmarker_v2_with_blendshapes.task"
        check(model_path, CHECKPOINT_SHA)
        check(task_path, TASK_SHA)
        self.model = None
        if variant != "mp":
            self.model = tf.keras.models.load_model(str(model_path), compile=False)
            self.infer = tf.function(lambda image, head, face: self.model(
                {"image": image, "head_vector": head, "face_origin_3d": face}, training=False
            ))
        vision = mp.tasks.vision
        self.detector = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(task_path),
                delegate=mp.tasks.BaseOptions.Delegate.CPU),
            running_mode=vision.RunningMode.VIDEO if video else vision.RunningMode.IMAGE,
            num_faces=2, min_face_detection_confidence=0.6,
            min_face_presence_confidence=0.6, min_tracking_confidence=0.6,
            output_facial_transformation_matrixes=True,
        ))
        self.video = video
        self.reset_geometry()

    def reset_geometry(self):
        self.face_width = None
        self.intrinsics = None
        self.perspective = None

    def step(self, rgb, time_us, conversion_ms):
        started = time.perf_counter_ns()
        height, width = rgb.shape[:2]
        frame = mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))
        detected = self.detector.detect_for_video(frame, time_us // 1000) if self.video else self.detector.detect(frame)
        landmark_end = time.perf_counter_ns()
        faces = len(detected.face_landmarks)
        result = {"time": time_us, "faces": faces, "camera": [width, height],
                  "prepareMs": conversion_ms, "landmarkMs": (landmark_end - started) / 1e6,
                  "extraPrepareMs": 0, "modelMs": 0, "postMs": 0}
        if faces != 1 or not detected.facial_transformation_matrixes:
            result["wetReason"] = "tracking_lost" if not faces else "ambiguous_face" if faces > 1 else "missing_pose"
            return result

        landmarks = detected.face_landmarks[0]
        transform = detected.facial_transformation_matrixes[0]
        result["matrix"] = transform.flatten(order="F").tolist()
        result["landmarks"] = {i: [landmarks[i].x, landmarks[i].y] for i in LANDMARKS}
        if self.model is None:
            return result

        pts = np.asarray([[p.x, p.y, p.z] for p in landmarks])
        pixels = pts[:, :2] * [width, height]
        g = self.geometry
        if any(g.compute_ear(pixels, side) < 0.2 for side in ("left", "right")):
            result["wetReason"] = "blink"
            return result
        try:
            patch = g.obtain_eyepatch(rgb, pixels)
            if self.intrinsics is None:
                self.intrinsics = g.estimate_camera_intrinsics(np.zeros((height, width, 3), np.uint8))
                self.perspective = g.create_perspective_matrix(aspect_ratio=width / height)
                self.face_width = g.estimate_face_width(pts[:, :2], transform)
            _, mesh = g.face_reconstruction(
                perspective_matrix=self.perspective, face_landmarks=pts,
                face_width_cm=self.face_width, face_rt=transform, K=self.intrinsics,
                frame_height=height, frame_width=width, frame=rgb,
            )
            face = g.estimate_gaze_origins(face_landmarks_3d=mesh, face_landmarks=pixels)["face_origin_3d"]
            head = g.get_head_vector(transform)
        except (ValueError, cv2.error, np.linalg.LinAlgError):
            result["wetReason"] = "eye_or_pose_preparation_failed"
            return result
        before_network = time.perf_counter_ns()
        result["extraPrepareMs"] = (before_network - landmark_end) / 1e6
        with tf.device(os.environ.get("OJOS_TF_DEVICE", "/CPU:0")):
            output = self.infer(
                tf.convert_to_tensor(patch[None], dtype=tf.float32) / 255.0,
                tf.convert_to_tensor(np.asarray(head)[None], dtype=tf.float32),
                tf.convert_to_tensor(np.asarray(face)[None], dtype=tf.float32),
            ).numpy()[0]
        result["modelMs"] = (time.perf_counter_ns() - before_network) / 1e6
        if output.shape != (2,) or not np.isfinite(output).all():
            result["wetReason"] = "invalid_network_output"
            return result
        result["wet"] = [*map(float, output + 0.5), 0, 0, 0, 0, 0]
        result["pose"] = [*map(float, head), *map(float, face)]
        return result


def local_run(args):
    meta = json.loads(args.index.read_text(encoding="utf8"))
    start, stop = meta["windows"][args.window]
    if args.duration:
        stop = min(stop, start + int(args.duration * 1e6))
    height = args.height
    width = round(meta["camera"][0] * height / meta["camera"][1])
    model = Native(args.upstream, video=True, variant=args.variant)
    started = time.perf_counter()
    count = 0
    rate = 1e6 / args.rate
    next_due = None
    with av.open(str(args.recording / "webcam.webm")) as video, args.output.open("w", encoding="utf8") as out:
        stream = video.streams.video[0]
        origin = None
        for frame in video.decode(stream):
            if frame.pts is None:
                continue
            stamp = round(frame.pts * frame.time_base * 1e6)
            origin = stamp if origin is None else origin
            stamp -= origin
            if stamp >= stop:
                break
            if stamp < start:
                continue
            next_due = stamp if next_due is None else next_due
            if stamp + 1e-5 < next_due:
                continue
            next_due += (int((stamp - next_due + 1e-5) // rate) + 1) * rate
            before_rgb = time.perf_counter_ns()
            rgb = frame.to_ndarray(format="rgb24")
            if (width, height) != (frame.width, frame.height):
                rgb = cv2.resize(rgb, (width, height), interpolation=cv2.INTER_AREA)
            converted = (time.perf_counter_ns() - before_rgb) / 1e6
            result = model.step(rgb, stamp, converted)
            out.write(json.dumps(result, separators=(",", ":"), allow_nan=False) + "\n")
            count += 1
    timing = {"frames": count, "wall_s": time.perf_counter() - started, "tensorflow": tf.__version__,
              "gpus": [d.name for d in tf.config.list_logical_devices("GPU")],
              "height": height, "rate": args.rate, "window": args.window}
    args.output.with_suffix(".timing.json").write_text(json.dumps(timing, indent=2) + "\n", encoding="utf8")
    print(json.dumps(timing), flush=True)


def public_run(args):
    started = time.perf_counter()
    with ZipFile(args.archive) as data:
        model_input = Native(args.upstream, video=False, variant="both")
        for person in args.people:
            prefix = f"Data/{person}/"
            rows = [line.split()[:3] for line in data.read(prefix + person + ".txt").decode().splitlines()]
            rows.sort()
            screen = loadmat(io.BytesIO(data.read(prefix + "Calibration/screenSize.mat")))
            width, height = (int(screen[f"{axis}_pixel"].item()) for axis in ("width", "height"))
            model_input.reset_geometry()
            day_groups = [list(group) for _, group in itertools.groupby(rows, lambda row: row[0].split("/")[0])]
            selected = list(itertools.chain.from_iterable(day_groups[:3]))
            selected += list(itertools.chain.from_iterable(day_groups[3:]))[::args.stride]
            with (args.output / f"{person}.jsonl").open("w", encoding="utf8") as out:
                for item, tx, ty in selected:
                    before_rgb = time.perf_counter_ns()
                    image = cv2.imdecode(np.frombuffer(data.read(prefix + item), dtype=np.uint8), cv2.IMREAD_COLOR_RGB)
                    result = model_input.step(image, 0, (time.perf_counter_ns() - before_rgb) / 1e6)
                    result.update(person=person, image=item, target=[float(tx), float(ty)], screen=[width, height])
                    out.write(json.dumps(result, separators=(",", ":"), allow_nan=False) + "\n")
            print(json.dumps({"person": person, "frames": len(selected), "elapsed": time.perf_counter() - started}),
                  flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--index", type=Path)
    parser.add_argument("--recording", type=Path)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--people", nargs="+", default=["p13", "p14"])
    parser.add_argument("--stride", type=int, default=3)
    parser.add_argument("--variant", choices=["mp", "both"], default="both")
    parser.add_argument("--window", default="calibration")
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--rate", type=int, default=30)
    parser.add_argument("--duration", type=float)
    args = parser.parse_args()
    cv2.setNumThreads(1)
    tf.config.threading.set_inter_op_parallelism_threads(1)
    tf.config.threading.set_intra_op_parallelism_threads(2)
    if args.archive:
        args.output.mkdir(parents=True, exist_ok=True)
        public_run(args)
    else:
        local_run(args)


if __name__ == "__main__":
    main()
