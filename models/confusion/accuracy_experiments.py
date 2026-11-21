"""Run the fixed participant-disjoint experiments described in experiments/protocol.md."""

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
from torch.utils.data import DataLoader

from model import ConfusionModel
from preprocess import MEAN, STD
from train import ClipDataset, clip_metrics, keep_clips, run_epoch

SEED = 20261121
FOLDS = 4
CONTROLS = ("majority", "pooled-cnn", "baseline-gru")
CANDIDATES = ("regularized-gru", "frozen-motion")
EPOCHS = {"pooled-cnn": 7, "baseline-gru": 8, "regularized-gru": 8}


def make_folds(rows):
    by_person = defaultdict(list)
    for row in rows:
        by_person[row["participant"]].append(row["label"])
    people = sorted(by_person)
    counts = np.array([np.bincount(by_person[person], minlength=2) for person in people])
    rng = np.random.default_rng(SEED)
    total = counts.sum(0)
    best_error = float("inf")
    assignments = None
    for _ in range(4096):
        groups = np.array_split(rng.permutation(len(people)), FOLDS)
        distribution = np.array([counts[group].sum(0) for group in groups])
        if not np.all(distribution):
            continue
        error = np.sum((distribution / total - 1 / FOLDS) ** 2)
        if error < best_error:
            best_error = error
            assignments = {people[i]: fold for fold, group in enumerate(groups) for i in group}
    if assignments is None:
        raise ValueError("No class-complete participant fold assignment")
    return assignments


class AugmentedClips(ClipDataset):
    def __getitem__(self, index):
        row, tracks = super().__getitem__(index)
        flip = random.random() < 0.5
        brightness = random.uniform(0.85, 1.15)
        contrast = random.uniform(0.85, 1.15)
        mean = torch.tensor(MEAN)[None, :, None, None]
        std = torch.tensor(STD)[None, :, None, None]
        scale = brightness * contrast
        offset = (mean * (scale - 1) + 0.5 * brightness * (1 - contrast)) / std
        for track in tracks:
            for index, frames in enumerate(track):
                shifted = (frames * scale + offset).clamp(-mean / std, (1 - mean) / std)
                track[index] = shifted.flip(-1) if flip else shifted
        return row, tracks


class RegularizedGRU(ConfusionModel):
    def __init__(self):
        super().__init__(pretrained=True)
        self.features[:-4].requires_grad_(False)
        self.projection_dropout = nn.Dropout(0.25)

    def train(self, mode=True):
        super().train(mode)
        for module in self.features.modules():
            if isinstance(module, nn.BatchNorm2d):
                module.eval()
        return self

    def encode(self, images):
        return self.projection_dropout(super().encode(images))


def seed_all(seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def fit_neural(mode, train_rows, validation_rows, root, device, seed):
    seed_all(seed)
    regularized = mode == "regularized-gru"
    if regularized:
        model = RegularizedGRU()
    else:
        model = ConfusionModel("cnn" if mode == "pooled-cnn" else "gru", pretrained=True)
    model.to(device, memory_format=torch.channels_last)
    features = [p for p in model.features.parameters() if p.requires_grad]
    head = [p for name, p in model.named_parameters() if not name.startswith("features.")]
    optimizer = torch.optim.AdamW([{"params": features, "lr": 1e-4}, {"params": head, "lr": 1e-3}])
    training = AugmentedClips if regularized else ClipDataset
    inputs = DataLoader(training(root, train_rows), batch_size=8, shuffle=True, collate_fn=keep_clips)
    validation = DataLoader(ClipDataset(root, validation_rows), batch_size=8, collate_fn=keep_clips)
    for _ in range(EPOCHS[mode]):
        run_epoch(model, inputs, device, optimizer=optimizer)
    return run_epoch(model, validation, device)[1]


@torch.inference_mode()
def motion_features(rows, root, device):
    """Cache statistics from a fixed backbone, with no fit to the evaluation clips."""
    model = ConfusionModel("cnn", pretrained=True).eval().to(device, memory_format=torch.channels_last)
    encoded = {}
    for row, tracks in ClipDataset(root, rows):
        variability = []
        velocity = []
        shifts = []
        for track in tracks:
            frames = torch.cat(track).to(device).contiguous(memory_format=torch.channels_last)
            vectors = model.pool(model.features(frames)).flatten(1)
            variability.append((len(vectors), vectors.std(dim=0, unbiased=False)))
            delta = vectors.diff(dim=0)
            if len(delta):
                velocity.append(delta.abs())
                half = len(vectors) // 2
                shifts.append((len(vectors), (vectors[-half:].mean(0) - vectors[:half].mean(0)).abs()))
        zero = torch.zeros(576, device=device)
        variation = sum(size * vector for size, vector in variability) / row["usable"]
        change = torch.cat(velocity).mean(0) if velocity else zero
        shift = sum(size * vector for size, vector in shifts) / sum(size for size, _ in shifts) if shifts else zero
        encoded[row["id"]] = torch.cat((variation, change, shift)).cpu()
    return encoded


def prediction(row, score):
    return {"clip_id": row["id"], "participant": row["participant"], "label": row["label"], "score": score}


def fit_motion(train_rows, validation_rows, features):
    inputs = torch.stack([features[row["id"]] for row in train_rows]).double()
    labels = torch.tensor([row["label"] for row in train_rows], dtype=torch.float64)
    loc, scale = inputs.mean(0), inputs.std(0, unbiased=False).clamp(min=1e-5)
    inputs = ((inputs - loc) / scale).clamp(-5, 5)
    linear = nn.Linear(inputs.shape[1], 1, dtype=torch.float64)
    nn.init.zeros_(linear.weight)
    nn.init.zeros_(linear.bias)
    optimizer = torch.optim.LBFGS(linear.parameters(), max_iter=80, line_search_fn="strong_wolfe")

    def closure():
        optimizer.zero_grad()
        logits = linear(inputs).squeeze(1)
        loss = F.binary_cross_entropy_with_logits(logits, labels) + 0.1 * linear.weight.square().sum()
        loss.backward()
        return loss

    optimizer.step(closure)
    evaluation = torch.stack([features[row["id"]] for row in validation_rows]).double()
    with torch.inference_mode():
        scores = linear(((evaluation - loc) / scale).clamp(-5, 5)).squeeze(1).sigmoid().tolist()
    return [prediction(row, score) for row, score in zip(validation_rows, scores)]


def fit(mode, training, evaluation, root, device, features, seed):
    if mode == "majority":
        return [prediction(row, 0.0) for row in evaluation]
    if mode == "frozen-motion":
        return fit_motion(training, evaluation, features)
    return fit_neural(mode, training, evaluation, root, device, seed)


def metrics(records):
    return clip_metrics([r["label"] for r in records], [r["score"] for r in records])


def accuracy_delta_interval(candidate, reference):
    baseline = {r["clip_id"]: r for r in reference}
    groups = defaultdict(list)
    if len(baseline) != len(reference) or {r["clip_id"] for r in candidate} != baseline.keys():
        raise ValueError("Paired bootstrap requires predictions for the same unique clips")
    for row in candidate:
        control = baseline[row["clip_id"]]
        label = row["label"]
        difference = int((row["score"] >= 0.5) == label) - int((control["score"] >= 0.5) == label)
        groups[row["participant"]].append(difference)
    counts = np.asarray([(sum(values), len(values)) for _, values in sorted(groups.items())])
    rng = np.random.default_rng(SEED)
    resampled = rng.integers(0, len(counts), size=(10_000, len(counts)))
    deltas, sizes = counts[resampled].sum(axis=1).T
    return np.quantile(deltas / sizes, [0.025, 0.975]).tolist()


def choose(models, out_of_fold):
    def rank(mode):
        values = models[mode]["pooled"]
        return values["accuracy"], values["balanced_accuracy"]

    reference = max(CONTROLS, key=rank)
    accepted = []
    comparisons = {}
    for candidate in CANDIDATES:
        baseline, proposed = models[reference], models[candidate]
        improvement = proposed["pooled"]["accuracy"] - baseline["pooled"]["accuracy"]
        balanced = proposed["pooled"]["balanced_accuracy"] - baseline["pooled"]["balanced_accuracy"]
        wins = sum(left["accuracy"] > right["accuracy"] for left, right in zip(proposed["folds"], baseline["folds"]))
        interval = accuracy_delta_interval(out_of_fold[candidate], out_of_fold[reference])
        passes = improvement >= 0.05 and balanced >= 0.02 and wins >= 3 and interval[0] > 0
        if passes:
            accepted.append(candidate)
        comparisons[candidate] = {"accuracy_delta": improvement, "balanced_accuracy_delta": balanced,
                                  "accuracy_delta_95pct_ci": interval, "fold_wins": wins, "passes": passes}
    return {"reference": reference, "comparisons": comparisons, "selected": max(accepted, key=rank, default=None)}


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def run_development(root, output, source, device):
    manifest = json.loads(source)
    if (manifest["dataset"], manifest["hz"]) != ("devemo-plus", 8):
        raise ValueError("This protocol requires the existing 8 Hz DevEmo+ cache")
    original = [r for r in manifest["clips"] if r["split"] in ("train", "validation")]
    development = [r for r in original if r["usable"]]
    if len({r["id"] for r in development}) != len(development):
        raise ValueError("Duplicate development clip IDs")
    assignments = make_folds(development)
    output.mkdir(parents=True)
    write_json(output / "fold_assignments.json", assignments)
    models = {}
    out_of_fold = {}
    fold_data = []
    for fold in range(FOLDS):
        eligible = [r for r in development if assignments[r["participant"]] == fold]
        fold_data.append({"participants": sum(f == fold for f in assignments.values()),
                          "clips": len(eligible), "positives": sum(r["label"] for r in eligible)})
    frozen = motion_features(development, root, device)
    for mode in (*CONTROLS, *CANDIDATES):
        records = []
        by_fold = []
        for fold in range(FOLDS):
            train = [r for r in development if assignments[r["participant"]] != fold]
            val = [r for r in development if assignments[r["participant"]] == fold]
            predictions = fit(mode, train, val, root, device, frozen, SEED + fold)
            scores = metrics(predictions)
            print(json.dumps({"mode": mode, "fold": fold + 1, "metrics": scores}), flush=True)
            by_fold.append(scores)
            records.extend(predictions)
        out_of_fold[mode] = records
        models[mode] = {"pooled": metrics(records), "folds": by_fold}
        write_json(output / f"{mode}-predictions.json", records)
    decision = choose(models, out_of_fold)
    result = {"seed": SEED, "manifest_sha256": hashlib.sha256(source).hexdigest(),
              "development": {"original_clips": len(original), "scored_clips": len(development),
                              "original_people": len({r["participant"] for r in original}),
                              "scored_people": len(assignments), "folds": fold_data},
              "models": models, "decision": decision}
    write_json(output / "development.json", result)
    print(json.dumps({"decision": decision}), flush=True)
    return result


def run_holdout(root, output, source, device, result):
    selected = result["decision"]["selected"]
    if selected is None:
        print("Stopping: no candidate cleared the development gate.", flush=True)
        return
    rows = json.loads(source)["clips"]
    original = [r for r in rows if r["split"] == "test"]
    test = [r for r in original if r["usable"]]
    development = [r for r in rows if r["split"] in ("train", "validation") and r["usable"]]
    if {r["participant"] for r in original} & {r["participant"] for r in development}:
        raise ValueError("Participant crossed the held-out split")
    reference = result["decision"]["reference"]
    frozen = motion_features(development + test, root, device) if selected == "frozen-motion" else None
    candidate = fit(selected, development, test, root, device, frozen, SEED + FOLDS)
    control = fit(reference, development, test, root, device, frozen, SEED + FOLDS)
    report = {"coverage": len(test) / len(original), "selected": selected, "reference": reference,
              "candidate": metrics(candidate), "control": metrics(control),
              "accuracy_delta_95pct_ci": accuracy_delta_interval(candidate, control)}
    write_json(output / "holdout.json", report)
    print(json.dumps({"holdout": report}), flush=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("prepared", type=Path)
    p.add_argument("output", type=Path)
    p.add_argument("--device", default="cuda")
    args = p.parse_args()
    torch.set_num_threads(2)
    torch.backends.cudnn.deterministic = True
    source = (args.prepared / "manifest.json").read_bytes()
    result = run_development(args.prepared, args.output, source, args.device)
    run_holdout(args.prepared, args.output, source, args.device, result)


if __name__ == "__main__":
    main()
