"""Run the pinned Face Landmarker once per labeled MPIIFaceGaze image."""
import argparse
from concurrent.futures import ProcessPoolExecutor
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import statistics
import time
from zipfile import ZipFile

# Do not oversubscribe the shared instance with BLAS pools.
os.environ["OPENBLAS_NUM_THREADS"] = "1"
os.environ["OMP_NUM_THREADS"] = "1"

import mediapipe as mp
import numpy as np
from PIL import Image
from scipy.io import loadmat

MODEL_SHA256 = "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff"
DATA_MD5 = "dcd051b577c55701e143957edac8be51"
# Only these points are used by the production extractor. No images are copied.
LANDMARK_IDS = (33, 133, 159, 145, 468, 362, 263, 386, 374, 473)


def result_record(result):
    faces = len(result.face_landmarks)
    record = {"faces": faces}
    if faces != 1 or len(result.facial_transformation_matrixes) != 1:
        return record
    matrix = result.facial_transformation_matrixes[0]
    landmarks = result.face_landmarks[0]
    record["landmarks"] = {
        i: [landmarks[i].x, landmarks[i].y] for i in LANDMARK_IDS
    }
    record["matrix"] = matrix.flatten(order="F").tolist()
    return record


def extract_person(args):
    archive, model, output, person = args
    vision = mp.tasks.vision
    options = vision.FaceLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(
            model_asset_path=str(model), delegate=mp.tasks.BaseOptions.Delegate.CPU
        ),
        running_mode=vision.RunningMode.IMAGE,
        num_faces=2,
        min_face_detection_confidence=0.6,
        min_face_presence_confidence=0.6,
        min_tracking_confidence=0.6,
        output_facial_transformation_matrixes=True,
    )
    prefix = f"Data/{person}/"
    timings = []
    wall_start = time.perf_counter()
    with ZipFile(archive) as dataset, vision.FaceLandmarker.create_from_options(options) as detector:
        screen = loadmat(io.BytesIO(dataset.read(prefix + "Calibration/screenSize.mat")))
        width, height = (int(screen[f"{axis}_pixel"].item()) for axis in ("width", "height"))
        labels = dataset.read(prefix + person + ".txt").decode().splitlines()
        temp = output / f"{person}.jsonl.partial"
        with temp.open("w", encoding="utf-8") as handle:
            for row in sorted(labels):
                path, target_x, target_y, *_ = row.split()
                with Image.open(io.BytesIO(dataset.read(prefix + path))) as image:
                    rgb = np.asarray(image.convert("RGB"))
                frame = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                start = time.perf_counter()
                raw = result_record(detector.detect(frame))
                timings.append((time.perf_counter() - start) * 1000)
                raw.update(
                    person=person, image=path, screen=[width, height],
                    target=[float(target_x), float(target_y)],
                    camera=[rgb.shape[1], rgb.shape[0]],
                )
                handle.write(json.dumps(raw, separators=(",", ":"), allow_nan=False) + "\n")
        temp.rename(output / f"{person}.jsonl")
    summary = {
        "person": person, "frames": len(labels), "median_ms": statistics.median(timings),
        "p95_ms": float(np.quantile(timings, 0.95)),
        "sum_inference_s": sum(timings) / 1000,
        "wall_s": time.perf_counter() - wall_start,
    }
    print(json.dumps(summary), flush=True)
    return summary


def verify_file(path, algorithm, expected):
    with path.open("rb") as handle:
        actual = hashlib.file_digest(handle, algorithm).hexdigest()
    if actual != expected:
        raise ValueError(f"Unexpected {algorithm} for {path}: {actual}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=3)
    args = parser.parse_args()
    started = time.perf_counter()
    verify_file(args.data, "md5", DATA_MD5)
    verify_file(args.model, "sha256", MODEL_SHA256)
    args.output.mkdir(parents=True, exist_ok=True)
    jobs = [(args.data, args.model, args.output, f"p{i:02}") for i in range(15)]
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        people = list(pool.map(extract_person, jobs))
    total = sum(p["frames"] for p in people)
    inference_seconds = sum(p["sum_inference_s"] for p in people)
    elapsed = time.perf_counter() - started
    report = {
        "data_md5": DATA_MD5, "model_sha256": MODEL_SHA256, "workers": args.workers,
        "python": platform.python_version(), "mediapipe": mp.__version__,
        "platform": platform.platform(), "images": total,
        "mean_inference_ms": inference_seconds * 1000 / total,
        "end_to_end_images_per_second": total / elapsed, "wall_s": elapsed,
        "per_person": people,
    }
    (args.output / "extraction.json").write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
