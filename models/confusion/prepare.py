"""Build person-disjoint clip manifests and prepare time-sampled face tracks."""

import argparse
import csv
import io
import json
import random
import re
import zipfile
from collections import Counter, defaultdict
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path

import av
import cv2
import numpy as np

from preprocess import FacePreprocessor, Sampler


@dataclass(frozen=True)
class Clip:
    id: str
    path: str
    participant: str
    split: str
    label: int
    annotation: str
    conditions: tuple = ()


def devemo(root):
    metadata = json.loads((root / "devemo+.json").read_text(encoding="utf-8"))
    filenames = Counter(row["filename"] for row in metadata)
    raw = Counter(row["label"] for row in metadata)
    print(json.dumps({"archive_rows": len(metadata),
                      "archive_people": len({r["participant"] for r in metadata}),
                      "annotation_counts": raw}, sort_keys=True), flush=True)
    ambiguous = sorted(name for name, count in filenames.items() if count > 1)
    unlabeled = sorted({p.name for p in root.glob("*.mp4")} - filenames.keys())
    print(json.dumps({"ambiguous_participant_media": ambiguous, "unlabeled_media": unlabeled}), flush=True)
    retained = [r for r in metadata if filenames[r["filename"]] == 1 and r["label"] in ("Confusion", "Neutral")]
    by_person = defaultdict(Counter)
    for row in retained:
        by_person[row["participant"]][row["label"]] += 1
    people = sorted(by_person)
    train_end, val_end = round(len(people) * 0.70), round(len(people) * 0.85)
    groups = ("train", "validation", "test")
    fractions = (0.70, 0.15, 0.15)
    totals = sum(by_person.values(), Counter())
    rng = random.Random(2026)
    best = float("inf")
    assignment = {}
    for _ in range(2048):
        rng.shuffle(people)
        splits = (people[:train_end], people[train_end:val_end], people[val_end:])
        counts = [sum((by_person[p] for p in members), Counter()) for members in splits]
        if any(not all(c[k] for k in totals) for c in counts):
            continue
        error = sum((count[k] / totals[k] - fraction) ** 2
                    for count, fraction in zip(counts, fractions) for k in totals)
        if error < best:
            best = error
            assignment = {p: split for split, members in zip(groups, splits) for p in members}
    if not assignment:
        raise ValueError("No person-disjoint three-way DevEmo+ split with both classes")
    return [Clip(Path(r["filename"]).stem, r["filename"], r["participant"], assignment[r["participant"]],
                 int(r["label"] == "Confusion"), r["label"], tuple(r["conditions"]))
            for r in retained]


def daisee(source):
    archive = zipfile.ZipFile(source) if source.is_file() else None
    try:
        names = archive.namelist() if archive else [
            p.relative_to(source).as_posix() for p in source.rglob("*") if p.is_file()
        ]
        media = {}
        for path in names:
            match = re.search(r"(?:^|/)DataSet/(Train|Validation|Test)/([^/]+)/[^/]+/([^/]+\.avi)$",
                              path, re.IGNORECASE)
            if match:
                split, person, name = match.groups()
                key = (split.lower(), name.casefold())
                if key in media:
                    raise ValueError(f"Duplicate DAiSEE media for {key}")
                media[key] = (person, path)
        clips = []
        for split in ("train", "validation", "test"):
            matches = [p for p in names if p.lower().endswith(f"labels/{split}labels.csv")]
            if len(matches) != 1:
                raise ValueError(f"Expected one official {split} label CSV")
            content = archive.read(matches[0]) if archive else (source / matches[0]).read_bytes()
            records = csv.DictReader(io.StringIO(content.decode("utf-8-sig")))
            for row in records:
                values = {k.strip().casefold(): v.strip() for k, v in row.items() if k}
                name = values["clipid"]
                level = int(values["confusion"])
                if level not in range(4):
                    raise ValueError(f"Unexpected DAiSEE confusion level for {name}: {level}")
                key = (split, name.casefold())
                if key not in media:
                    raise ValueError(f"Official label is missing its video: {key}")
                participant, path = media[key]
                clips.append(Clip(Path(name).stem, path, participant, split, int(level >= 2), str(level)))
        return clips
    finally:
        if archive:
            archive.close()


def validate_splits(clips):
    participants = {}
    ids = set()
    for clip in clips:
        if clip.id in ids:
            raise ValueError(f"Duplicate clip: {clip.id}")
        ids.add(clip.id)
        if participants.setdefault(clip.participant, clip.split) != clip.split:
            raise ValueError(f"Invalid participant split: {clip.participant}")
    for split in ("train", "validation", "test"):
        if {c.label for c in clips if c.split == split} != {0, 1}:
            raise ValueError(f"Missing a class in the {split} split")


def subset(clips, max_per_class):
    rng = random.Random(2026)
    groups = defaultdict(list)
    for clip in sorted(clips, key=lambda c: c.id):
        groups[clip.split, clip.label].append(clip)
    return [clip for group in groups.values() for clip in rng.sample(group, min(max_per_class, len(group)))]


def sample_video(container, sampler):
    """Keep presentation timestamps and frame IDs, dropping duplicate timestamps."""
    start = None
    last_us = 0
    for frame_id, frame in enumerate(container.decode(video=0)):
        if frame.pts is None or frame.time_base is None:
            raise ValueError("Source frame has no presentation timestamp")
        source_us = round(frame.pts * frame.time_base * 1_000_000)
        if start is None:
            start = source_us
        last_us = source_us - start
        if sampler is None or sampler.take(last_us):
            yield last_us, frame_id, frame.to_ndarray(format="bgr24")


def prepare_clip(source, clip, tracker, out, hz):
    sampler = Sampler(hz)
    tracker.clear()
    frames, times, tracks, ids = [], [], [], []
    reasons = Counter()
    count = 0
    if source.is_file():
        with zipfile.ZipFile(source) as archive:
            video = io.BytesIO(archive.read(clip.path))
    else:
        video = str(source / clip.path)
    with av.open(video) as container:
        for time_us, frame_id, frame in sample_video(container, sampler):
            count += 1
            crop = tracker.observe(time_us, frame)
            reasons[crop.reason] += 1
            if crop.rgb is not None:
                frames.append(crop.rgb)
                times.append(time_us)
                tracks.append(crop.track)
                ids.append(frame_id)
    if not count:
        raise ValueError(f"No decodable video frames: {clip.id}")
    if frames:
        np.savez(out / f"{clip.id}.npz", frames=np.stack(frames), time_us=np.asarray(times),
                 track=np.asarray(tracks), frame_id=np.asarray(ids))
    return {**asdict(clip), "sampled": count, "usable": len(frames), "skipped_ticks": sampler.skipped_ticks,
            "quality": reasons}


def init_worker(asset):
    cv2.setNumThreads(1)
    global tracker
    tracker = FacePreprocessor(asset)


def prepare_job(args):
    source, clip, out, hz = args
    try:
        return prepare_clip(source, clip, tracker, out, hz)
    except (ValueError, av.FFmpegError, OSError) as exc:
        raise RuntimeError(f"Could not prepare {clip.id} from {clip.path}") from exc


def report(clips):
    stats = {}
    for split in ("train", "validation", "test"):
        rows = [c for c in clips if c["split"] == split]
        usable = [c for c in rows if c["usable"]]
        persons = defaultdict(Counter)
        quality = Counter()
        for c in rows:
            persons[c["participant"]].update({"clips": 1, f"label_{c['label']}": 1, "usable_clips": bool(c["usable"]),
                                              "sampled_frames": c["sampled"], "usable_frames": c["usable"]})
            quality.update(c["quality"])
        sampled, frames = sum(quality.values()), quality["usable"]
        stats[split] = {"clips": len(rows), "participants": len(persons), "annotation_counts": Counter(
            c["annotation"] for c in rows), "class_counts": Counter(c["label"] for c in rows),
            "usable_class_counts": Counter(c["label"] for c in usable), "sampled_frames": sampled,
            "usable_frames": frames, "usable_face_coverage": frames / sampled, "quality": quality,
            "skipped_ticks": sum(c["skipped_ticks"] for c in rows), "per_participant": persons}
    return stats


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("dataset", choices=("daisee", "devemo-plus"))
    p.add_argument("source", type=Path)
    p.add_argument("asset", type=Path)
    p.add_argument("output", type=Path)
    p.add_argument("--hz", type=int, choices=(4, 8, 16), default=8)
    p.add_argument("--workers", type=int, default=4)
    p.add_argument("--max-clips-per-class", type=int, help="Cap the number of prepared clips per split and class")
    args = p.parse_args()
    clips = devemo(args.source) if args.dataset == "devemo-plus" else daisee(args.source)
    validate_splits(clips)
    if args.max_clips_per_class is not None:
        if args.max_clips_per_class < 1:
            p.error("--max-clips-per-class must be positive")
        clips = subset(clips, args.max_clips_per_class)
    args.output.mkdir(parents=True)
    frames = args.output / "frames"
    frames.mkdir()
    with ProcessPoolExecutor(args.workers, initializer=init_worker, initargs=(args.asset,)) as pool:
        rows = []
        for row in pool.map(prepare_job, ((args.source, c, frames, args.hz) for c in clips)):
            rows.append(row)
            if len(rows) % 20 == 0:
                print(f"Prepared {len(rows)}/{len(clips)} clips", flush=True)
    summary = report(rows)
    (args.output / "manifest.json").write_text(json.dumps({"dataset": args.dataset, "hz": args.hz, "clips": rows,
                                                          "summary": summary}, indent=2) + "\n", encoding="utf-8")
    for split, counts in summary.items():
        print(split, json.dumps({k: v for k, v in counts.items() if k != "per_participant"}, sort_keys=True))


if __name__ == "__main__":
    main()
