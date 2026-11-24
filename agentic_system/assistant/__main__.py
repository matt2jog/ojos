from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

from .baseline import DEFAULT_BASELINE_MODEL, BaselineAnalyzer
from .gemini import GeminiProvider, ProviderError
from .media import load_bundle
from .server import serve


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ojos desktop clip analysis")
    commands = parser.add_subparsers(dest="command", required=True)

    analyze = commands.add_parser("analyze", help="Analyze one exported desktop bundle")
    analyze.add_argument("--bundle", type=Path, required=True)
    server = commands.add_parser("serve", help="Serve desktop clip jobs on loopback")
    server.add_argument("--port", type=int, default=8766)
    server.add_argument("--chat-only", action="store_true", help="Serve local chat using the configured cloud model relay")
    server.add_argument("--chat-db", type=Path, help="Local SQLite file for persistent ADK chat history")
    for command in (analyze, server):
        command.add_argument("--model", default=DEFAULT_BASELINE_MODEL)
        command.add_argument("--thinking", choices=("minimal", "low", "medium", "high", "xhigh"), default="low")
        command.add_argument("--timeout", type=float, default=20, help="Gemini request timeout in seconds")
    return parser.parse_args()


def gemini_api_key() -> str:
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
        raise ValueError("Set GEMINI_API_KEY in the environment or assistant/.env")
    return api_key


def live_provider(args: argparse.Namespace) -> GeminiProvider:
    return GeminiProvider(gemini_api_key(), args.model, thinking=args.thinking, timeout=args.timeout)


def main() -> int:
    args = parse_args()
    try:
        chat_only = args.command == "serve" and args.chat_only
        analyzer = None if chat_only else BaselineAnalyzer(
            live_provider(args), include_audio=os.environ.get("OJOS_CLIP_PLAYBACK_AUDIO") == "1")
        if args.command == "serve":
            token = os.environ.get("OJOS_LOCAL_TOKEN", "")
            if not token:
                raise ValueError("Set OJOS_LOCAL_TOKEN to the bearer token your local client will use")
            chat = None
            if args.chat_db:
                from .adk_chat import ChatService

                roots = [path for path in os.environ.get("OJOS_CHAT_ROOTS", "").split(os.pathsep) if path]
                relay = os.environ.get("OJOS_MODEL_RELAY_URL", "") if chat_only else ""
                cloud_token = os.environ.get("OJOS_CLOUD_TOKEN", "").strip() if chat_only else ""
                if chat_only and not (relay and cloud_token):
                    raise ValueError("Cloud chat requires a model relay and an access token")
                chat = ChatService("ojos-cloud" if chat_only else gemini_api_key(),
                                   os.environ.get("OJOS_CHAT_MODEL", args.model), args.chat_db, roots,
                                   relay_url=relay, cloud_token=cloud_token)
            serve(analyzer, token=token, port=args.port, chat=chat)
        else:
            analysis = analyzer.analyze(load_bundle(args.bundle))
            print(json.dumps({**analysis.screen_analysis, "metrics": analysis.metrics}, indent=2))
    except (OSError, ValueError, ProviderError) as error:
        print(f"ojos: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
