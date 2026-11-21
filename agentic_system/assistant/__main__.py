from __future__ import annotations

import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import sys
from time import perf_counter

from .baseline import DEFAULT_BASELINE_MODEL, DEFAULT_BASELINE_VARIANT, BaselineAnalyzer, DemoBaselineProvider
from .core import DEFAULT_VARIANT, VARIANTS, Memory, Tutor, elapsed_ms
from .gemini import GeminiProvider, ProviderError
from .media import InputError, load_bundle, load_tracking, prepare_media


DEFAULT_MODEL = "gemini-4-hydrogen"


def add_input(parser: argparse.ArgumentParser) -> None:
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--bundle", type=Path, help="Folder containing manifest.json, gaze.json and video.mp4")
    inputs.add_argument("--video", type=Path, help="MP4 from Matt's tracking export")
    parser.add_argument("--tracking", type=Path, help="Companion tracking JSON for --video")
    parser.add_argument("--event-start-us", type=int, help="Optional observed event start relative to the MP4")
    parser.add_argument("--event-end-us", type=int, help="Optional observed event end relative to the MP4")
    parser.add_argument("--still-at-us", type=int, help="Override the reference time for the targeted still")


def add_model(parser: argparse.ArgumentParser, *, default: str = DEFAULT_MODEL) -> None:
    parser.add_argument("--model", default=default)
    parser.add_argument("--thinking", choices=("minimal", "low", "medium", "high", "xhigh"), default="low")
    parser.add_argument("--timeout", type=float, default=20, help="Gemini request timeout in seconds")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze Ojos screen recordings and run replay experiments")
    commands = parser.add_subparsers(dest="command", required=True)

    analyze = commands.add_parser("analyze", help="Infer the likely confusion, possible questions, and a helpful summary")
    add_input(analyze)
    add_model(analyze, default=DEFAULT_BASELINE_MODEL)
    analyze.add_argument("--variant", choices=VARIANTS, default=DEFAULT_BASELINE_VARIANT)

    inspect = commands.add_parser("inspect", help="Validate a clip and measure evidence variants offline")
    add_input(inspect)
    inspect.add_argument("--variant", choices=VARIANTS, action="append", help="Repeat to select several variants")

    ask = commands.add_parser("ask", help="Generate a question from one clip using Gemini")
    add_input(ask)
    add_model(ask)
    ask.add_argument("--variant", choices=VARIANTS, default=DEFAULT_VARIANT)
    ask.add_argument("--memory-from", type=Path, help="Load active task memory from a prior ask result")
    ask.add_argument("--reply", help="The learner's reply to the previous question")

    compare = commands.add_parser("compare", help="Run independent Gemini calls against the same clip")
    add_input(compare)
    add_model(compare)
    compare.add_argument("--variant", choices=VARIANTS, action="append", help="Repeat to select several variants")

    evaluation = commands.add_parser("eval", help="Run the replay evaluation")
    add_model(evaluation)
    evaluation.add_argument("--provider", choices=("scripted", "gemini"), default="scripted")
    evaluation.add_argument("--variant", choices=VARIANTS, default=DEFAULT_VARIANT)

    server = commands.add_parser("serve", help="Start the prototype v1 backend on localhost")
    add_model(server, default=DEFAULT_BASELINE_MODEL)
    server.add_argument("--provider", choices=("scripted", "gemini"), default="gemini")
    server.add_argument("--variant", choices=VARIANTS, default=DEFAULT_BASELINE_VARIANT)
    server.add_argument("--port", type=int, default=8766)
    return parser.parse_args()


def requested_clip(args: argparse.Namespace):
    if args.bundle is not None:
        if any(value is not None for value in (args.tracking, args.event_start_us, args.event_end_us)):
            raise ValueError("A v1 bundle supplies its own tracking and event time")
        return load_bundle(args.bundle)
    if args.tracking is None:
        raise ValueError("--video requires --tracking")
    return load_tracking(
        args.video, args.tracking, event_start_us=args.event_start_us, event_end_us=args.event_end_us,
    )


def live_provider(args: argparse.Namespace) -> GeminiProvider:
    api_key = (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip()
    if not api_key:
        try:
            local_config = Path(__file__).with_name(".env").read_text(encoding="utf-8")
        except FileNotFoundError:
            local_config = ""
        for line in local_config.splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "GEMINI_API_KEY":
                api_key = value.strip()
                break
    if not api_key:
        raise ValueError("Set GEMINI_API_KEY in the environment or assistant/.env. Inspection and scripted evals work offline.")
    return GeminiProvider(api_key, args.model, thinking=args.thinking, timeout=args.timeout)


def inspect_clip(clip, variants, still_time) -> dict:
    preparations = []
    for variant in variants:
        start = perf_counter()
        video, frames, gaze = prepare_media(
            clip, variant, attach_still_at_us=still_time if variant == "video-gaze-still" else None,
        )
        preparations.append({
            "variant": variant,
            "preparation_ms": elapsed_ms(start),
            "video_bytes": len(video or b""),
            "stills": [{"time_us": pts, "bytes": len(data)} for pts, data in frames],
            "gaze_samples_prepared": len(gaze),
        })
    return {
        "mode": "offline_media_inspection",
        "duration_us": clip.duration_us,
        "event_start_us": clip.event_start_us,
        "event_end_us": clip.event_end_us,
        "viewport": [clip.width_px, clip.height_px],
        "valid_gaze_samples_loaded": len(clip.gaze),
        "variants": preparations,
    }


def compare_clip(tutor: Tutor, clip, variants, still_time) -> dict:
    results = []
    for variant in dict.fromkeys(variants):
        try:
            outcome = tutor.analyze(
                clip, variant=variant, attach_still_at_us=still_time if variant == "video-gaze-still" else None,
            )
        except (InputError, ProviderError) as error:
            results.append({"variant": variant, "error": str(error)})
        else:
            results.append({"variant": variant, **asdict(outcome)})
    return {"mode": "live_gemini", "results": results}


def load_memory(path: Path) -> Memory | None:
    try:
        with path.open("rb") as source:
            data = source.read(64 * 1024 + 1)
        if len(data) > 64 * 1024:
            raise ValueError("Result file is too large")
        record = json.loads(data)["memory"]
        memory = Memory(**record) if record is not None else None
        if memory is not None:
            core_fields = (memory.task, memory.sticking_point, memory.last_question)
            reply_fields = (memory.last_reply, memory.last_reply_to)
            if any(not isinstance(value, str) or not value.strip() or len(value) > 400 for value in core_fields):
                raise ValueError("Invalid task memory field")
            if any(value is not None and (not isinstance(value, str) or len(value) > 1000) for value in reply_fields):
                raise ValueError("Invalid reply memory field")
        return memory
    except (KeyError, TypeError, ValueError, RecursionError) as error:
        raise ValueError("--memory-from must contain a prior ask result") from error


def main() -> int:
    args = parse_args()
    try:
        if args.command == "eval":
            from .eval import run_eval

            provider = live_provider(args) if args.provider == "gemini" else None
            report = run_eval(provider, variant=args.variant)
            print(json.dumps(report, indent=2))
            return 0 if report["passed"] else 1
        if args.command == "serve":
            from .server import serve

            token = os.environ.get("OJOS_LOCAL_TOKEN", "")
            if not token:
                raise ValueError("Set OJOS_LOCAL_TOKEN to the bearer token your local client will use")
            provider = live_provider(args) if args.provider == "gemini" else DemoBaselineProvider()
            serve(BaselineAnalyzer(provider, variant=args.variant), token=token, port=args.port)
            return 0

        if args.command == "inspect":
            if args.still_at_us is not None and args.variant and "video-gaze-still" not in args.variant:
                raise ValueError("--still-at-us requires the video-gaze-still variant")
            outcome = inspect_clip(requested_clip(args), args.variant or VARIANTS, args.still_at_us)
        else:
            provider = live_provider(args)
            clip = requested_clip(args)
            if args.command in ("analyze", "ask"):
                if args.still_at_us is not None and args.variant != "video-gaze-still":
                    raise ValueError("--still-at-us requires the video-gaze-still variant")
                if args.command == "analyze":
                    analysis = BaselineAnalyzer(provider, variant=args.variant).analyze(clip, attach_still_at_us=args.still_at_us)
                    outcome = {**(analysis.screen_analysis or {}), "metrics": analysis.metrics}
                else:
                    memory = load_memory(args.memory_from) if args.memory_from else None
                    outcome = asdict(Tutor(provider).analyze(
                        clip, memory=memory, reply=args.reply, variant=args.variant, attach_still_at_us=args.still_at_us,
                    ))
            else:
                if args.still_at_us is not None and args.variant and "video-gaze-still" not in args.variant:
                    raise ValueError("--still-at-us requires the video-gaze-still variant")
                outcome = compare_clip(Tutor(provider), clip, args.variant or VARIANTS, args.still_at_us)
                print(json.dumps(outcome, indent=2))
                return 1 if any("error" in result for result in outcome["results"]) else 0
    except (OSError, ValueError, ProviderError) as error:
        print(f"ojos: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    print(json.dumps(outcome, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
