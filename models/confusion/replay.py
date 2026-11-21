"""Replay synthetic JSONL scores or a local video as vision worker events."""

import argparse
import json
import sys
from pathlib import Path
from uuid import uuid4

from intervals import Intervals


def score_events(path, session_id, model_version):
    interval = Intervals(session_id, model_version, "replay")
    with path.open(encoding="utf-8") as source:
        for line in source:
            if not line.strip():
                continue
            sample = json.loads(line)
            epoch = sample.get("capture_epoch", interval.capture_epoch)
            if epoch != interval.capture_epoch:
                interval.start_epoch(epoch)
            event = interval.step(sample["time_us"], sample["frame_id"], sample["probability"],
                                  reset=sample.get("reset", False))
            if event:
                yield event, sample["time_us"]


def video_events(path, artifact, yunet, session_id):
    import av

    from prepare import sample_video
    from runtime import ConfusionRuntime

    runtime = ConfusionRuntime(artifact, yunet, session_id, source="replay")
    with av.open(str(path)) as container:
        for time_us, frame_id, frame in sample_video(container, None):
            event = runtime.process(frame, time_us, frame_id)
            if event:
                yield event, time_us
    print(json.dumps(runtime.diagnostics()), file=sys.stderr)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--session", default=None, help="UUID to reuse for all events in this execution")
    p.add_argument("--record", type=Path, help="Write events with publication timestamps for offline evaluation")
    modes = p.add_subparsers(dest="mode", required=True)
    scores = modes.add_parser("scores")
    scores.add_argument("path", type=Path)
    scores.add_argument("--model-version", default="confusion-replay-1")
    video = modes.add_parser("video")
    video.add_argument("path", type=Path)
    video.add_argument("artifact", type=Path)
    video.add_argument("yunet", type=Path)
    args = p.parse_args()
    session = args.session or str(uuid4())
    events = (score_events(args.path, session, args.model_version) if args.mode == "scores"
              else video_events(args.path, args.artifact, args.yunet, session))
    records = []
    for event, published_us in events:
        print(json.dumps(event), flush=True)
        records.append({"event": event, "published_us": published_us})
    if args.record:
        args.record.write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
