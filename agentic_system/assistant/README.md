# Ojos assistant

The local Python service uses Google ADK and Gemini 4 Hydrogen by default. Clip analysis returns a suspected sticking point, up to three suggested questions, a short summary, and clip-relative evidence. It reads the screen video, one timestamped still, and up to 16 gaze hints with both tracker predictions, their mean, and the max box. Playback audio is opt-in through `OJOS_CLIP_PLAYBACK_AUDIO=1`.

## Run locally

Install Python 3.11+ and put FFmpeg and FFprobe on `PATH`. The desktop starts the service automatically with a generated bearer token. For a manual run from the repository root, set `GEMINI_API_KEY` and `OJOS_LOCAL_TOKEN` in the environment and run the following commands.

```sh
python -m pip install -r agentic_system/assistant/requirements.txt
python -m agentic_system.assistant serve --chat-db /path/to/chat.sqlite3
```

Submit an exported desktop bundle with the same bearer token in the client environment:

```sh
node agentic_system/assistant/desktop-client.mjs /path/to/bundle
```

To analyze a saved bundle without the HTTP service:

```sh
python -m agentic_system.assistant analyze --bundle /path/to/bundle
```

A bundle contains `video.mp4`, `manifest.json` and `gaze.json`. The service emits `job.analysis` immediately before `job.result` and supports resume, deduplication, and cancellation. [Desktop protocol](../../docs/protocol.md)

## Chat

Selecting a suggestion opens a chat with a timestamped JPEG from the clip, its summary, and up to five nearby gaze samples in encoded viewport pixels. Later turns reuse the chat's ID. The local SQLite database stores completed turns, compacted summaries, indexed passages, and saved notes. The agent reuses a stable instruction and context prefix for Gemini's implicit cache. Usage events report cached tokens when Gemini supplies that count. The agent keeps recent turns verbatim and summarizes older turns to stay within its context budget.

Gemini generates a short title and a one-line description alongside the first answer. The first completed turn saves the chat and its metadata. Older chats and title-request failures use a title and description derived from the opening exchange.

ADK can make dependent calls across the file, PDF, passage search, notes, public web search, and URL tools. File tools read only within `OJOS_CHAT_ROOTS`, with paths separated by the OS path separator. File excerpts, indexed passages, and tool results used in an answer may be sent to Gemini. Web lookups pass the public query or URL to a separate Gemini request.

The `run_subagent` tool accepts a focused `task`, a `model` of `gemini-4-hydrogen` or `gemini-4-neon`, and `reasoning` from `minimal` through `xhigh`. Each turn can launch up to four helpers. They share the chat’s tool permissions and total tool-call budget, and each returns findings to the parent from its own ADK invocation. Only the parent can delegate.

## Verify

```sh
python -m unittest discover -s agentic_system/assistant -t . -v
```

The tests use [generated screen media](../../testing/screen-sync-lab/README.md) and run without a provider key.
