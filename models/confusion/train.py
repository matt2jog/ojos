"""Train with clip supervision and detached recurrent state every four seconds."""

import argparse
import hashlib
import json
import random
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F
from torch.utils.data import DataLoader, Dataset

from model import HIDDEN, ConfusionModel
from preprocess import normalize

CHUNK_US = 4_000_000


class ClipDataset(Dataset):
    def __init__(self, root, rows):
        self.root = root
        self.rows = rows

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        row = self.rows[index]
        tracks = []
        with np.load(self.root / "frames" / f"{row['id']}.npz", allow_pickle=False) as data:
            frames, times, track = (data[key] for key in ("frames", "time_us", "track"))
            for track_id in np.unique(track):
                selected = track == track_id
                track_times = times[selected]
                chunks = (track_times - track_times[0]) // CHUNK_US
                segments = np.split(frames[selected], np.where(np.diff(chunks))[0] + 1)
                tracks.append([torch.from_numpy(normalize(segment).copy()) for segment in segments])
        return row, tracks


def keep_clips(batch):
    return batch


def clip_scores(model, batch, device):
    """Pool only observed frames, carrying distinct state per face track."""
    tracks = [(index, segments) for index, (_, clip_tracks) in enumerate(batch) for segments in clip_tracks]
    state = [None] * len(tracks)
    totals = torch.zeros(len(batch), device=device)
    counts = torch.as_tensor([row["usable"] for row, _ in batch], device=device)
    for chunk_index in range(max(len(segments) for _, segments in tracks)):
        active = [(lane, clip, chunks[chunk_index]) for lane, (clip, chunks) in enumerate(tracks)
                  if chunk_index < len(chunks)]
        lengths = [len(frames) for _, _, frames in active]
        flat = torch.cat([frames for _, _, frames in active]).to(device)
        projected = model.encode(flat.contiguous(memory_format=torch.channels_last))
        padded = nn.utils.rnn.pad_sequence(projected.split(lengths), batch_first=True)
        initial = None
        if model.gru is not None and chunk_index:
            initial = torch.stack([state[lane] for lane, _, _ in active], dim=0).unsqueeze(0)
        logits, hidden = model.classify(padded, initial)
        probabilities = logits.float().softmax(-1)[..., 1]
        observed = torch.arange(padded.shape[1], device=device) < torch.tensor(lengths, device=device)[:, None]
        per_track = (probabilities * observed).sum(dim=1)
        clips = torch.as_tensor([clip for _, clip, _ in active], device=device)
        totals = totals.index_add(0, clips, per_track)
        if model.gru is not None:
            for row, ((lane, _, _), length) in enumerate(zip(active, lengths)):
                state[lane] = hidden[row, length - 1].detach()
    return totals / counts


def clip_metrics(labels, predictions):
    labels = np.asarray(labels, dtype=np.int64)
    predictions = np.asarray(predictions)
    positive = int(labels.sum())
    negative = len(labels) - positive
    if not positive or not negative:
        raise ValueError("Clip metrics require both classes")
    predicted = predictions >= 0.5
    tp, fp = int(labels[predicted].sum()), int(predicted.sum() - labels[predicted].sum())
    fn, tn = positive - tp, negative - fp
    order = np.argsort(-predictions, kind="stable")
    edges = np.r_[np.where(np.diff(predictions[order]))[0], len(labels) - 1]
    tps = np.r_[0, np.cumsum(labels[order])[edges]]
    fps = np.r_[0, (edges + 1) - tps[1:]]
    ap = np.sum(np.diff(tps / positive) * tps[1:] / (tps[1:] + fps[1:]))
    return {"clips": len(labels), "positive": positive, "negative": negative, "accuracy": (tp + tn) / len(labels),
            "majority_accuracy": max(positive, negative) / len(labels),
            "balanced_accuracy": (tp / positive + tn / negative) / 2, "precision": tp / max(1, tp + fp),
            "recall": tp / positive, "average_precision": float(ap),
            "roc_auc": float(np.trapezoid(tps / positive, fps / negative)),
            "tp": tp, "fp": fp, "tn": tn, "fn": fn}


def run_epoch(model, loader, device, optimizer=None):
    model.train(optimizer is not None)
    records = []
    loss_total = 0.0
    with torch.set_grad_enabled(optimizer is not None):
        for batch in loader:
            labels = torch.tensor([row["label"] for row, _ in batch], dtype=torch.float32, device=device)
            scores = clip_scores(model, batch, device)
            loss = F.binary_cross_entropy(scores.clamp(1e-6, 1 - 1e-6), labels)
            if optimizer is not None:
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 5)
                optimizer.step()
            loss_total += loss.item() * len(batch)
            for (row, _), score in zip(batch, scores.detach().cpu().tolist()):
                records.append({"clip_id": row["id"], "participant": row["participant"],
                                "label": row["label"], "score": score})
    metrics = clip_metrics([r["label"] for r in records], [r["score"] for r in records])
    metrics["loss"] = loss_total / len(records)
    return metrics, records


def save_checkpoint(path, model, metadata):
    temporary = path.with_suffix(".tmp")
    torch.save({"weights": model.state_dict(), **metadata}, temporary)
    temporary.replace(path)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("prepared", type=Path)
    p.add_argument("output", type=Path)
    p.add_argument("--model", choices=("gru", "cnn"), default="gru")
    p.add_argument("--epochs", type=int, default=8)
    p.add_argument("--batch", type=int, default=8)
    p.add_argument("--device", default="cuda")
    p.add_argument("--seed", type=int, default=2026)
    p.add_argument("--random-init", action="store_true")
    p.add_argument("--workers", type=int, default=2)
    args = p.parse_args()
    if args.epochs < 1:
        p.error("--epochs must be positive")
    args.output.mkdir(parents=True)
    torch.set_num_threads(2)
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.backends.cudnn.deterministic = True
    manifest_bytes = (args.prepared / "manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    by_split = defaultdict(list)
    for row in manifest["clips"]:
        if row["usable"]:
            by_split[row["split"]].append(row)
    for split in ("train", "validation", "test"):
        if {r["label"] for r in by_split[split]} != {0, 1}:
            raise ValueError(f"No eligible clips of both classes in {split}")
    loaders = {split: DataLoader(ClipDataset(args.prepared, rows), batch_size=args.batch,
                                 shuffle=split == "train", collate_fn=keep_clips, num_workers=args.workers,
                                 persistent_workers=args.workers > 0) for split, rows in by_split.items()}
    model = ConfusionModel(args.model, pretrained=not args.random_init).to(args.device, memory_format=torch.channels_last)
    head = [p for name, p in model.named_parameters() if not name.startswith("features.")]
    optimizer = torch.optim.AdamW([{"params": model.features.parameters(), "lr": 1e-4}, {"params": head, "lr": 1e-3}])
    best_ap = -1.0
    checkpoint = args.output / "best.pt"
    run = {"dataset": manifest["dataset"], "hz": manifest["hz"], "mode": args.model,
           "seed": args.seed, "pretrained": not args.random_init, "chunk_us": CHUNK_US,
           "epochs": args.epochs, "batch": args.batch, "torch": str(torch.__version__),
           "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
           "model_version": f"confusion-{manifest['dataset']}-{args.model}-{manifest['hz']}hz-1",
           "parameters": sum(p.numel() for p in model.parameters())}
    history = []
    for epoch in range(1, args.epochs + 1):
        train, _ = run_epoch(model, loaders["train"], args.device, optimizer)
        validation, _ = run_epoch(model, loaders["validation"], args.device)
        info = {"epoch": epoch, "train": train, "validation": validation}
        history.append(info)
        print(json.dumps(info), flush=True)
        if validation["average_precision"] > best_ap:
            best_ap = validation["average_precision"]
            save_checkpoint(checkpoint, model, {**run, "best_epoch": epoch})
    saved = torch.load(checkpoint, map_location=args.device, weights_only=True)
    model.load_state_dict(saved["weights"])
    test, predictions = run_epoch(model, loaders["test"], args.device)
    test_summary = manifest["summary"]["test"]
    raw_count = test_summary["class_counts"]
    test["all_clips"] = sum(raw_count.values())
    test["all_clips_majority_accuracy"] = max(raw_count.values()) / test["all_clips"]
    test["clip_coverage"] = test["clips"] / test["all_clips"]
    test["usable_face_coverage"] = test_summary["usable_face_coverage"]
    test["skipped_ticks"] = test_summary["skipped_ticks"]
    test["per_participant"] = test_summary["per_participant"]
    result = {**run, "best_epoch": saved["best_epoch"], "history": history, "test": test}
    (args.output / "metrics.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    (args.output / "test-clips.json").write_text(json.dumps(predictions, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"test": {k: v for k, v in test.items() if k != "per_participant"}}), flush=True)


if __name__ == "__main__":
    main()
