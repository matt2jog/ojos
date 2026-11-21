"""Evaluate held-out continuous sessions with temporal IoU matching."""

import argparse
import json
import statistics
from collections import defaultdict
from pathlib import Path

IOU_FLOOR = 0.30
HOUR_US = 3_600_000_000


def iou(first, second):
    start = max(first["start_us"], second["start_us"])
    end = min(first["end_us"], second["end_us"])
    union = max(first["end_us"], second["end_us"]) - min(first["start_us"], second["start_us"])
    return max(0, end - start) / union


def match(events, truth):
    """Maximum-cardinality one-to-one matches, preferring higher IoU locally."""
    neighbors = []
    for event in events:
        candidates = [(iou(event, interval), index) for index, interval in enumerate(truth)
                      if event["capture_epoch"] == interval["capture_epoch"]]
        neighbors.append([j for overlap, j in sorted(candidates, key=lambda item: -item[0])
                          if overlap >= IOU_FLOOR])
    assignments = {}

    def assign(prediction, visited):
        for annotation in neighbors[prediction]:
            if annotation in visited:
                continue
            visited.add(annotation)
            if annotation not in assignments or assign(assignments[annotation], visited):
                assignments[annotation] = prediction
                return True
        return False

    for prediction in range(len(events)):
        assign(prediction, set())
    return [(events[prediction], truth[annotation]) for annotation, prediction in assignments.items()]


def validate(session):
    events = session["published"]
    duration = session["duration_us"]
    if duration <= 0:
        raise ValueError("Expected a positive continuous evaluation duration")
    if not 0 <= session["usable_frames"] <= session["sampled_frames"] or session["skipped_ticks"] < 0:
        raise ValueError("Invalid frame diagnostics")
    for interval in [*(record["event"] for record in events), *session["help_wanted"]]:
        if not 0 <= interval["start_us"] < interval["end_us"] <= duration or interval["capture_epoch"] < 0:
            raise ValueError("Invalid interval bounds or epoch")
    for record in events:
        event = record["event"]
        if (event["session_id"] != session["session_id"] or event["source"] != "live"
                or not event["end_us"] <= record["published_us"] <= duration):
            raise ValueError("Expected live events with session-aligned publication timestamps")


def summarize(sessions):
    duration = sampled = usable = skipped = predicted = actual = 0
    onset, publish = [], []
    for session in sessions:
        duration += session["duration_us"]
        sampled += session["sampled_frames"]
        usable += session["usable_frames"]
        skipped += session["skipped_ticks"]
        events = []
        for record in session["published"]:
            events.append({**record["event"], "published_us": record["published_us"]})
        truth = session["help_wanted"]
        predicted += len(events)
        actual += len(truth)
        for detection, annotation in match(events, truth):
            onset.append(detection["start_us"] - annotation["start_us"])
            publish.append(detection["published_us"] - annotation["start_us"])
    tp = len(onset)
    return {"sessions": len(sessions), "predictions": predicted, "annotations": actual,
            "true_positives": tp, "false_positives": predicted - tp, "false_negatives": actual - tp,
            "precision": tp / predicted if predicted else None, "recall": tp / actual if actual else None,
            "false_panes_per_hour": (predicted - tp) * HOUR_US / duration,
            "median_onset_delay_us": statistics.median(onset) if onset else None,
            "median_publish_delay_us": statistics.median(publish) if publish else None,
            "usable_face_coverage": usable / sampled if sampled else None,
            "skipped_ticks": skipped, "duration_us": duration}


def evaluate(sessions):
    by_domain = defaultdict(list)
    ids = set()
    for session in sessions:
        validate(session)
        if session["session_id"] in ids:
            raise ValueError("Duplicate evaluation session")
        ids.add(session["session_id"])
        by_domain[session["domain"]].append(session)
    result = {}
    for domain, rows in by_domain.items():
        by_person = defaultdict(list)
        for row in rows:
            by_person[row["participant"]].append(row)
        result[domain] = {**summarize(rows), "per_participant": {person: summarize(person_rows)
                                                               for person, person_rows in by_person.items()}}
    return result


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("sessions", type=Path)
    args = p.parse_args()
    print(json.dumps(evaluate(json.loads(args.sessions.read_text(encoding="utf-8"))), indent=2))


if __name__ == "__main__":
    main()
