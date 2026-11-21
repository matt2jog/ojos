# Ojos clip assistant

The local Python service analyzes desktop clip bundles and returns a suspected sticking point, up to three possible questions, a short summary, and clip-relative evidence. The current provider uses Gemini 4 Hydrogen by default. It reads the screen video, one timestamped still, and up to 16 gaze hints.

## Run locally

Install Python 3.10+ and put FFmpeg and FFprobe on `PATH`. The desktop starts the service automatically with a generated bearer token. For a manual run from the repository root, set `GEMINI_API_KEY` and `OJOS_LOCAL_TOKEN` in the environment, then run:

```sh
python -m agentic_system.assistant serve
```

Submit an exported desktop bundle with the same bearer token in the client environment:

```sh
node agentic_system/assistant/desktop-client.mjs /path/to/bundle
```

To analyze a saved bundle without the HTTP service:

```sh
python -m agentic_system.assistant analyze --bundle /path/to/bundle
```

A bundle contains `video.mp4`, `manifest.json` and `gaze.json`. The [desktop protocol](../../docs/protocol.md) defines the multipart request and SSE events. The service emits `job.analysis` immediately before `job.result`, and supports resume, deduplication and cancellation. Electron handles the selected-question explainer separately.

## Verify

```sh
python -m unittest discover -s agentic_system/assistant -t . -v
```

The tests use [generated screen media](../../spikes/screen-sync-lab/README.md) and run without a provider key.
