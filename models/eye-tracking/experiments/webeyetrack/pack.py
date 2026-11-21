"""Stage original VP8 packets and normalized target metadata locally."""
import argparse
import json
from pathlib import Path

import av


def stage(source, output):
    capture = json.loads((source / "capture.json").read_text(encoding="utf8"))
    trial = next(a for a in reversed(capture["gaze_calibration_attempts"])
                 if a["status"] == "complete" and len(a["targets"]) == 14)
    origin = next(f for f in capture["files"] if f["name"] == "webcam.webm")["started"]["performance_ms"]

    def relative(entry):
        return round((entry["performance_ms"] - origin) * 1000)

    targets = [{
        "kind": target["kind"], "id": target["id"],
        "start": relative(target["collect_from"]), "end": relative(target["collect_until"]),
        "point": [target["x_normalized"], target["y_normalized"]],
    } for target in trial["targets"]]
    windows = {"calibration": [max(0, targets[0]["start"] - 1000000), targets[-1]["end"] + 150000]}
    previous = source / "analysis/results.json"
    if previous.exists():
        questions = json.loads(previous.read_text(encoding="utf8"))["reasoning"]["questions"]
        windows["reasoning"] = [round(questions[0]["start_s"] * 1e6),
                                round(questions[-1]["end_s"] * 1e6)]

    output.mkdir(parents=True, exist_ok=True)
    frames = []
    offset = 0
    with av.open(str(source / "webcam.webm")) as video, (output / "packets.bin").open("wb") as data:
        stream = video.streams.video[0]
        if stream.codec_context.name != "vp8":
            raise ValueError("Expected original VP8 recording")
        first_pts = None
        for packet in video.demux(stream):
            if packet.pts is None or not packet.size:
                continue
            pts = round(packet.pts * packet.time_base * 1e6)
            if first_pts is None:
                first_pts = pts
            content = bytes(packet)
            frames.append([pts - first_pts, offset, len(content), int(packet.is_keyframe)])
            data.write(content)
            offset += len(content)
        width, height = stream.width, stream.height

    meta = {"camera": [width, height], "viewport": [trial["viewport_width_px"], trial["viewport_height_px"]],
            "codec": "vp8", "targets": targets, "windows": windows, "frames": frames}
    (output / "index.json").write_text(json.dumps(meta, separators=(",", ":")), encoding="utf8")
    print(json.dumps({"camera": meta["camera"], "viewport": meta["viewport"], "windows": windows,
                      "packets": len(frames), "bytes": offset}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recording", type=Path)
    parser.add_argument("output", type=Path)
    options = parser.parse_args()
    stage(options.recording, options.output)
