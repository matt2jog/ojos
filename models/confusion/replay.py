"""Run real confusion inference on a recorded video for offline evaluation."""

import argparse
import json
import sys
from pathlib import Path
from uuid import uuid4

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
    video = modes.add_parser("video")
    video.add_argument("path", type=Path)
    video.add_argument("artifact", type=Path)
    video.add_argument("yunet", type=Path)
    args = p.parse_args()
    session = args.session or str(uuid4())
    events = video_events(args.path, args.artifact, args.yunet, session)
    records = []
    for event, published_us in events:
        print(json.dumps(event), flush=True)
        records.append({"event": event, "published_us": published_us})
    if args.record:
        args.record.write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
