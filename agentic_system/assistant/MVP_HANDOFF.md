# Ojos MVP handoff

One recorded screen clip and its timestamped gaze go to the local Python backend. **Gemini 4 Hydrogen** returns a suspected sticking point, up to three possible questions, and a short summary. Keep that result for the current nudge. The user can opt in to see the summary in the existing panel.

## Files by task

| Task | What you need |
| --- | --- |
| Run Hydrogen on Matt’s original sample | `interval-04-screen.mp4`, `interval-04-tracking.json`, and a local `GEMINI_API_KEY`. Use the `analyze --video … --tracking …` command in the [assistant README](README.md#run-it-on-matts-files). |
| Run Hydrogen on a new desktop export | `video.mp4`, `gaze.json`, and `manifest.json` in one folder. The MP4 contains the screen, the gaze file carries timestamps and coordinates, and the manifest ties the clip to its session, interval and capture dimensions. Run `python3 -m agentic_system.assistant analyze --bundle /path/to/export`. |
| Test or wire the desktop upload | [`desktop-client.mjs`](desktop-client.mjs) sends that bundle to the running backend. [`generate.py`](../../spikes/screen-sync-lab/media/generate.py) makes a synthetic bundle if you need one. |
| Find or change the AI behavior | [`baseline.py`](baseline.py) sets the model, prompt and response shape. [`media.py`](media.py) reads the input and prepares the clip, still and gaze hints. [`server.py`](server.py) handles upload and results. |

Keep keys and real capture files local. The repo ships the software and synthetic fixture generator.

## Run the baseline

Use Python 3.10+, Node 22+, and `ffmpeg` and `ffprobe` on `PATH`. The synthetic fixture generator also needs the `libx264` encoder. Run from the repo root on Victor’s backend branch with this handoff.

Start the server in one terminal. Scripted mode uses a fixed Python example so the team can exercise the complete upload and response without a Gemini key.

```sh
export OJOS_LOCAL_TOKEN=ojos-demo
python3 -m agentic_system.assistant serve --provider scripted
```

In a second terminal, generate a disposable fixture and send it through the same endpoint the desktop will use.

```sh
export OJOS_LOCAL_TOKEN=ojos-demo
python3 spikes/screen-sync-lab/media/generate.py --output-dir ../ojos-mvp-replay
node agentic_system/assistant/desktop-client.mjs ../ojos-mvp-replay
```

On PowerShell use `$env:OJOS_LOCAL_TOKEN = 'ojos-demo'` in each terminal and `python` in place of `python3` if needed. Use a fresh output directory each time you generate a fixture. The client accepts any exported folder containing `manifest.json`, `gaze.json`, and `video.mp4`.

For live analysis, set `GEMINI_API_KEY` in the backend environment or in the gitignored `agentic_system/assistant/.env` and restart `serve` with no `--provider` argument. Keep the Gemini key in the backend. `--model` overrides Hydrogen for experiments. The [assistant README](README.md) has the command for Matt’s original MP4 and tracking pair, which uses a different sidecar from desktop bundles.

## Connect the three parts

| Branch or component | What exists | What needs wiring |
| --- | --- | --- |
| Alejandro’s `proto/doodle`, merged into `main` | Electron overlay with the mascot, question pills, and a summary-capable text panel. `src/main/index.ts` uses a hotkey, mouse position, one screenshot, and direct Gemini calls. | Feed `nudge()` an exported bundle and use the backend response for suggestion pills and the opt-in panel. |
| Matt’s vision code on `main` and `models` | `VisionSession` publishes intervals and exports fused gaze v2. `ml/confusion` and `ml/eye-tracking` are the standalone model branches. | Initialize workers and calibration in the desktop host. Pass `onInterval` to clip export, and export v2 against the actual MP4 bounds and dimensions. |
| Recorder and backend on Victor’s branch | Standalone `Recorder` exports a screen MP4 and a manifest. The backend accepts the v1 manifest with either v1 or v2 gaze. | Give the recorder and vision session the same session ID, epoch, display dimensions and clock. Run one full capture-to-overlay test on the demo machine. |

1. **Wire the replay first.** In `prototypes/doodle/src/main/index.ts`, use the existing nudge flow with a fixture bundle. Import `analyzeBundle({ manifest, gaze, video, token, signal })` from [`desktop-client.mjs`](desktop-client.mjs) or copy its HTTP calls. Use the Electron main process for the token and upload. The helper submits `POST /v1/jobs` and waits for `job.analysis` and `job.result` on the job’s SSE stream. Keep the current `runId` check before sending updates to the renderer. Abort a pending call on dismissal or replacement.
2. **Map the response.** Set `Suggestions.stuck_on` from `suspected_confusion`, `Suggestions.questions` from `possible_questions`, and `Suggestions.summary` from `summary`. Keep `stuck_on` as tentative copy. The latest overlay hides it, so add it to the panel if all three fields need to be visible. Use the existing `reset`, `cmd` and `done` events to render the cached general summary on opt-in. Label it as a general hint. The backend has no route yet for answering a selected question. For `insufficient_evidence`, show the returned explanation and leave the question list empty. Keep the nudge in its loading state until the current result arrives, or until the user dismisses it.
3. **Swap in the live trigger.** Keep the hotkey as a manual fallback. Route Matt’s `VisionSession.onInterval(event)` and the hotkey to the same export and upload path. The recorder supplies the actual MP4 bounds. Call `VisionSession.exportClip(actualStartUs, actualEndUs)` with those bounds. Put the returned `gaze_status` in the manifest and `gaze` in the upload. The vision worker and camera stay on the laptop. See the [recorder entry points](../CAPTURE.md#handoff-to-alejandro-and-the-assistant) and [model host entry points](../../models/README.md).
4. **Test the combined app.** Start with the synthetic replay, then run the hotkey over a real capture, then try the live model trigger. Check that the questions and summary arrive, dismiss or replace a pending nudge, and repeat with gaze unavailable. Record time from trigger to pills on the demo machine. Verify capture permissions and model assets there.

## Current and future behavior

- **Current.** One Hydrogen call reads the audio-free screen video, up to 16 time-aligned gaze hints, and one timestamped still. For v2 the backend uses the fused point, region and fusion mode. Raw scores, individual tracker predictions, and camera frames stay outside the baseline Gemini request. The backend returns structured results and checks their fields and timestamp bounds.
- **After the demo path works.** Save short-lived task context across nudges and let the learner clarify or pick a question for a tailored reply. First collect cases where the learner says what they were stuck on. Replay a fixed set while changing the prompt, model, evidence, single versus split calls, or optional frame inspection. Compare intent and evidence accuracy, helpfulness, uncertainty handling and latency before adopting a change. Speech and drawing can use the same help result once the text flow is stable.

## Verification so far

`proto/doodle` passed `npm run typecheck` and `npm run build` from its branch snapshot. The backend upload client returned all three fields for v1, fused v2, and v2 with unavailable gaze in scripted replay. A live Hydrogen request through the upload client and v2 Python replay took 6.07 s from client launch to result. The default Hydrogen CLI ran on Matt’s 8.034 s desk puzzle clip in 7.65 s of backend processing. It recognized the actual draft and the ordering problem. It also asked a less useful formatting question. Matt’s clip has no confirmed intent label. The combined Electron, live vision and capture path still needs the demo-machine run above.
