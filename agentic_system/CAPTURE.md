# Ojos screen capture

The standalone Electron harness verifies capture and clip export on one selected monitor. It exports a local v1 bundle and uses one npm dependency plus the system FFmpeg tools. The desktop uses the same recorder from Electron main.

## Run

Use Node 22.12 or later and FFmpeg with `libx264`, the `setts` bitstream filter, and `ffprobe` on `PATH`. Run these commands from `agentic_system/capture/`. The first launch downloads the Electron runtime for your OS.

```sh
npm ci
npm test
npm start
```

1. Select a display and click **Start capture**. Use the system picker when prompted. For a smoke test, share a screen with a visible test counter and a change of question.
2. While recording, click **Export clip** and choose a destination folder. The harness writes up to the last 20 seconds in a unique `ojos-*` folder with `video.mp4`, `manifest.json`, and `gaze.json`.
3. Open the MP4 in a local player. To save the frame covering a clip-relative timestamp, run the command below with your paths. **Stop capture** clears the in-memory buffer. Exported bundles stay in the folder you chose.

```sh
node recorder.cjs /path/to/ojos-clip/video.mp4 5.4 /path/to/frame.png
```

## How it works

| Component | Responsibility |
| --- | --- |
| `main.cjs` and `preload.cjs` | Display selection, user-approved capture, desktop clock, and a narrow IPC interface. Wayland uses the compositor picker through PipeWire. |
| `renderer.js` | Reads Chromium video frames, scales proportionally to fit 1920 × 1080, and sends time-stamped JPEGs at up to about 15 fps. It aligns clocks using the lowest-round-trip ping and anchors the capture timeline on the first frame. The first-frame delay is a live sync measurement to check on each platform. |
| `recorder.cjs` | Retains up to 60 seconds or 96 MiB of JPEGs in memory. It uses frame presentation times to write a variable-frame-rate H.264 MP4, then verifies the duration and dimensions with FFprobe. Temporary frame files are removed after export. |

The standalone harness captures video only. JPEG frames keep the buffer and export logic independent of the OS encoder. Encoding runs at export time. A capture gap can hold the last image during playback, and gaze is invalidated where there is no recent screen frame. Source geometry changes discard the old buffer and advance the epoch. Sleep and display reconfiguration stop the session.

## Handoff to Alejandro and the assistant

Keep the [v1 protocol](../docs/protocol.md) at the handoff. In Electron main, the same `Recorder` supports `manual(nowUs)` or `addGaze(sample)` plus `interval(event, nowUs)`, followed by `writeBundle(clip, parentFolder)`. Session and epoch IDs, viewport dimensions, and clock alignment must be shared with Matt’s worker before live gaze can be enabled. The harness currently exposes manual export. Automatic intervals and gaze are exercised by replay.

The delayed replay test sends the interval `[14 s, 18 s)` at session time 19.2 s. It exports `[4 s, 19 s)`, rebases the gaze at 9.4 s to clip time 5.4 s, and checks the pixels of the extracted MP4 frame. Use [the existing replay fixture](../testing/screen-sync-lab/media/README.md) or an approved live export for Gemini. The [Gemini smoke runner](../testing/screen-sync-lab/gemini/README.md) currently accepts replay bundles. A live export uses `source: "manual"` and can be consumed by the future v1 job service.

## OS coverage

| Target | Before claiming support |
| --- | --- |
| macOS | Native capture of an isolated test window passed on arm64 in Electron 45.4.1. Start, export, decode and stop worked. Full-display permission and a packaged Retina run remain pending. |
| Windows | Verify monitor selection and export on a scaled or secondary display. |
| Linux Wayland | Verify the XDG ScreenCast and PipeWire picker, including cancellation, on a named compositor. [XDG ScreenCast portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html) |
| Linux X11 | Full-monitor recording, export and stop passed on Debian arm64 with a 1280 × 800 Xvfb display. Both test screen states were visible in the MP4. A packaged desktop run remains pending. |

For each target, record the OS and architecture. Check start, stop, permission denial, export while recording continues, frame timing, and actual dimensions. Target 100 ms or better between the observed marker and the exported frame. `npm test` passed on macOS arm64 and Debian arm64, including exact MP4 packet timing and pixel verification at the replay gaze timestamp. The packaged full-display matrix is pending.
