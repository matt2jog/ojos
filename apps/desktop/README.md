# Ojos desktop

Ojos starts recording the configured display after setup. Dismissing an offer or chat clears the overlay while local buffering continues. **Hide Ojos** hides the overlay and preserves the current offer or chat. **Show Ojos** restores it. Recalibration uses the active camera feed, and **Quit Ojos** ends capture. After sleep or a display interruption, Ojos reconnects when the configured source is available.

Open **Settings** from the button under the avatar or from the menu bar or tray. On macOS, clicking the Dock icon opens Settings, and its menu includes saved chats and visibility controls. On Windows, pin the installed Ojos shortcut to the taskbar to use its **Settings** and **Saved chats** actions. Launching Ojos again while it is running also opens Settings.

## Run from the repository

1. Build the pinned [WebEyeTrack worker](../../models/README.md#assets-and-preparation), and provision the authorized 8 Hz confusion and ETH-XGaze weights. Set `OJOS_MODEL_ASSETS` when the weights are outside the platform's local Ojos model-assets directory.
2. Put FFmpeg and FFprobe on `PATH`. Set `OJOS_PYTHON` to a Python runtime with the CPU vision dependencies, or use `OJOS_CONFUSION_PYTHON` and `OJOS_MODEL2_PYTHON` for separate environments. The [confusion](../../models/confusion/requirements.txt) and [ETH-XGaze](../../models/eye-tracking/experiments/eth-xgaze/README.md#reproduce) requirements describe the tested environments.
3. Install the [assistant requirements](../../agentic_system/assistant/requirements.txt) into the Python environment used by Electron. Set `OJOS_ASSISTANT_PYTHON` if the assistant uses a separate runtime. Put `GEMINI_API_KEY` in the gitignored repository-root `.env` or the process environment. Electron starts the local ADK service on loopback. For clip analysis, `OJOS_ASSISTANT_URL` and `OJOS_LOCAL_TOKEN` can select an existing endpoint. Chat uses the local service and defaults to Gemini 4 Hydrogen. Set `OJOS_CHAT_MODEL` to override it.
4. Run `npm ci` and `npm run dev` here. Complete the existing permissions, display, and calibration setup. On macOS, approve screen and system audio capture for the responsible process.

| Key (Ctrl/Alt on Windows) | Action |
| --- | --- |
| Cmd+Shift+O | Ask about the last 20 seconds of screen activity |
| Option+1 / 2 / 3 | Pick a suggested question while the mascot is showing |
| Cmd+Shift+X | Dismiss |
| Cmd+Shift+Q | Quit |

First launch opens the setup window (permissions, display, eye calibration). Re-run it with `npm run dev -- --setup` or from the menu-bar icon.

## Package and verify

Run `npm run package` on Windows x64 for NSIS or Apple Silicon macOS 14.2+ for DMG. Set `OJOS_RUNTIME_DIR` to a staged directory with redistributable FFmpeg and FFprobe in `bin/` and a relocatable Python with the CPU vision and assistant requirements under `python/`. Use `python/python.exe` on Windows and `python/bin/python3` on macOS. Packaging checks that ADK and pypdf import in that runtime.

The installer includes Electron, the capture worker, WebEyeTrack assets, Python, FFmpeg, and runtime source. Provision the restricted research checkpoints on each authorized machine via `OJOS_MODEL_ASSETS` or the local Ojos model-assets directory. For a packaged local assistant, configure the key through the environment or a private `.env` in Electron's user-data directory. The installer excludes credentials and restricted checkpoints.

Capture holds up to 60 seconds in memory, capped at 96 MiB for screen JPEGs and about 22 MiB for playback audio. The desktop uses the same viewport geometry and session clock for calibration, vision, and capture. Webcam frames stay local. Each help request encodes a temporary clip and attaches the clip-relative vision sidecar. Set `OJOS_CLIP_PLAYBACK_AUDIO=1` to include the validated playback track in the local assistant's Gemini request. Verify display selection, exported overlay exclusion, and a flash, tone, and gaze alignment check on each installed OS before demoing.

Chat history is saved in the Electron user-data directory. Open **Saved chats** under the avatar or from the tray to resume any conversation. Put files the chat can read in the `chat-files` subdirectory there, or set `OJOS_CHAT_ROOTS` to the folders it can read. Separate paths with `;` on Windows or `:` on macOS.
