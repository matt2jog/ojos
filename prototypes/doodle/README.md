# Ojos desktop

Ojos lives in the menu bar or tray. It starts recording the configured display after setup is completed and starts a fresh session on later launches. Use the existing **Pause**, **Resume**, and **Quit** commands to control it.

## Run from the repository

1. Build the pinned [WebEyeTrack worker](../../models/README.md#assets-and-preparation), and provision the authorized 8 Hz confusion and ETH-XGaze weights. Set `OJOS_MODEL_ASSETS` when the weights are outside the platform's local Ojos model-assets directory.
2. Put FFmpeg and FFprobe on `PATH`. Set `OJOS_PYTHON` to a Python runtime with the CPU vision dependencies, or use `OJOS_CONFUSION_PYTHON` and `OJOS_MODEL2_PYTHON` for separate environments. The [confusion](../../models/confusion/requirements.txt) and [ETH-XGaze](../../models/eye-tracking/experiments/eth-xgaze/README.md#reproduce) requirements describe the tested environments.
3. Keep `GEMINI_API_KEY` in the gitignored repository-root `.env` or in the process environment. With `OJOS_ASSISTANT_URL` and `OJOS_LOCAL_TOKEN` set, clip analysis uses that assistant endpoint. Otherwise Electron launches the local Python service on loopback. Set `OJOS_ASSISTANT_PYTHON` if it needs a separate runtime. The selected-question explainer uses `GEMINI_MODEL` (default `gemini-4-neon`) from Electron main.
4. Run `npm ci` and `npm run dev` here. Complete the existing permissions, display, and calibration setup. On macOS, approve screen and system audio capture for the responsible process.

| Key (Ctrl/Alt on Windows) | Action |
| --- | --- |
| Cmd+Shift+O | Ask about the last 20 seconds of screen activity |
| Option+1 / 2 / 3 | Pick a suggested question while the mascot is showing |
| Cmd+Shift+X | Dismiss |
| Cmd+Shift+Q | Quit |

First launch opens the setup window (permissions, display, eye calibration). Re-run it with `npm run dev -- --setup` or from the menu-bar icon.

## Package and verify

Run `npm run package` on Windows x64 for NSIS or Apple Silicon macOS 14.2+ for DMG. Set `OJOS_RUNTIME_DIR` to a staged directory with redistributable FFmpeg and FFprobe in `bin/` and a relocatable Python with the required CPU dependencies under `python/`. Use `python/python.exe` on Windows and `python/bin/python3` on macOS.

The installer includes Electron, the capture worker, WebEyeTrack assets, Python, FFmpeg, and runtime source. Provision the restricted research checkpoints on each authorized machine via `OJOS_MODEL_ASSETS` or the local Ojos model-assets directory. For a packaged local assistant, configure the key through the environment or a private `.env` in Electron's user-data directory. The installer excludes credentials and restricted checkpoints.

Capture holds up to 60 seconds in memory, capped at 96 MiB for screen JPEGs and about 22 MiB for playback audio. The desktop uses the same viewport geometry and session clock for calibration, vision, and capture. Webcam frames stay local. Each help request encodes a temporary clip and attaches the clip-relative vision sidecar. The current assistant baseline strips the captured playback track before sending video to Gemini. Verify display selection, exported overlay exclusion, and a flash, tone, and gaze alignment check on each installed OS before demoing.
