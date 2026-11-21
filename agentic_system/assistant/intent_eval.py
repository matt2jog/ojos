"""Replay the desk-assignment example with three controlled gaze inputs."""

from __future__ import annotations

import argparse
from dataclasses import replace
from hashlib import sha256
import json
from pathlib import Path
import sys

from .__main__ import add_model, live_provider
from .baseline import DEFAULT_BASELINE_MODEL, BaselineAnalyzer
from .gemini import ProviderError
from .media import load_tracking


class VerifiedMediaProvider:
    def __init__(self, provider):
        self.provider = provider
        self.name = provider.name
        self.shared_input = None

    def generate(self, *, system_instruction, context, video, frames, response_schema):
        if video is None or len(frames) != 1:
            raise ValueError("The comparison requires the full video and one fixed still")
        timestamp, still = frames[0]
        shared_context = {key: value for key, value in context.items() if key != "gaze"}
        current_input = {
            "video_sha256": sha256(video).hexdigest(),
            "still_sha256": sha256(still).hexdigest(),
            "fixed_still_us": timestamp,
            "system_instruction_sha256": sha256(system_instruction.encode()).hexdigest(),
            "context_without_gaze_sha256": sha256(json.dumps(shared_context, sort_keys=True).encode()).hexdigest(),
        }
        if self.shared_input is None:
            self.shared_input = current_input
        if current_input != self.shared_input:
            raise ValueError("Shared input changed between conditions")
        return self.provider.generate(system_instruction=system_instruction, context=context, video=video, frames=frames,
                                      response_schema=response_schema)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--tracking", type=Path, required=True)
    parser.add_argument("--still-at-us", type=int, default=4_000_000)
    parser.add_argument("--repeats", type=int, choices=range(1, 4), default=1)
    add_model(parser, default=DEFAULT_BASELINE_MODEL)
    args = parser.parse_args()

    try:
        clip = load_tracking(args.video, args.tracking)
        if not clip.gaze or clip.height_px < 102:
            raise ValueError("The comparison requires valid gaze and a viewport tall enough for the shifted-gaze control")
        if not 0 <= args.still_at_us < clip.duration_us:
            raise ValueError("--still-at-us must be inside the clip")
        provider = VerifiedMediaProvider(live_provider(args))
    except (OSError, ValueError) as error:
        print(f"ojos intent eval: {error}", file=sys.stderr)
        return 1

    # On the desk-assignment clip these synthetic positions land in browser chrome.
    shifted = tuple({**sample, "y_px": 37 + sample["y_px"] % 65} for sample in clip.gaze)
    conditions = (
        ("screen_only", replace(clip, gaze=())),
        ("recorded_gaze", clip),
        ("wrong_gaze_control", replace(clip, gaze=shifted)),
    )
    analyzer = BaselineAnalyzer(provider, variant="video-gaze-still")
    failed = False
    for trial in range(args.repeats):
        for condition, input_clip in conditions[trial:] + conditions[:trial]:
            row = {"condition": condition, "trial": trial + 1, "model": provider.name, "thinking": args.thinking}
            try:
                result = analyzer.analyze(input_clip, attach_still_at_us=args.still_at_us)
            except (ProviderError, OSError, ValueError) as error:
                row["error"] = str(error)
                failed = True
            else:
                row.update(screen_analysis=result.screen_analysis, metrics=result.metrics, shared_input=provider.shared_input)
            print(json.dumps(row, ensure_ascii=False), flush=True)
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
