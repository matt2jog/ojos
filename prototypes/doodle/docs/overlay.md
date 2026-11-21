# Ojos overlay (desktop UI)

This covers the desktop overlay, how users ask for help, and how answers appear. Alejandro owns the overlay. Victor owns the recorder and Gemini backend, and Matt owns the confusion and gaze models. [Shared protocol](../../../docs/protocol.md) · [Ownership](../../../docs/ownership.md) · [Desktop](../)

## Core rule

The user never has to type the question. Their face says *that* they might be stuck, their gaze says *what* they're stuck on, and one click (or keypress) says they actually want help. The confusion model also fires while people are just thinking hard, so Ojos never shows an answer unprompted.

## User flow (MVP)

1. **Confusion event:** the mascot slides in at the right edge of the screen. It's a dark pill with two eyes and a Google-colored "j" nose, so the face reads "o j o". The pupils follow the pointer (gaze later), and it blinks. The rest of the screen stays untouched.
2. **Suggested questions.** The assistant reads the clip and calibrated gaze when available. Suggested questions pop out above the mascot with shortcuts (⌥1/⌥2/⌥3, Alt on Windows), plus "Something else? Just explain". While loading, a shimmer pill shows and the nose's spark spins.
3. **Pick one:** click a pill, press its shortcut, or click the mascot for a generic explanation. The eyes squint happily, a rainbow glow appears around the screen and the side panel slides in.
4. **Answer:** the explainer streams a short text answer into the panel, with the chosen question as the heading.
5. **Close:** "Got it" or Cmd/Ctrl+Shift+X.
6. **Ignored.** The mascot slides away after 15 seconds and the desktop cancels any pending clip analysis. Hovering pauses the timer.

A new confusion event shows the mascot again without closing an answer the user is reading. Picking a new question replaces the open answer. Follow-ups that build on a previous question are out of scope for the MVP.

The overlay is a transparent, always-on-top, click-through window. Only the mascot, pills and panel take clicks. It is excluded from screen capture.

**Secondary feature, off by default:** live doodles. The explainer can also stream drawing commands, and hand-drawn circles, arrows, underlines, highlights and labels animate on the real screen in step with the text. Enable it with `--doodles`.

## First-run setup

Shown on first launch, from the tray ("Run setup again…", "Recalibrate eyes…"), or with `--setup`. One branded window:

1. **Welcome:** mascot, tagline, privacy notes.
2. **Permissions:** camera, Screen Recording (macOS) and system audio (macOS: comes with Screen Recording; Windows: none needed). Rows poll their status, "Allow" uses the OS prompt and "Open Settings" deep-links to the right pane. macOS needs a restart after Screen Recording is granted, so a "Restart Ojos" link is provided. A round, mirrored camera preview confirms the camera works.
3. **Display:** choose which screen to record and calibrate. Skipped when there's only one.
4. **Calibration:** full screen on that display. It runs on `EnsembleCalibration` from `models/vision`: 9 fit targets, then 5 validation targets. Each target is marked shown only after it's painted, held through `collectUntilUs`, then given 150 ms for late observations before `finishTarget`. Esc skips.
5. **Results:** per-model pass/fail with typical error against the limit. Passing profiles are saved with `saveTrackerProfile`, along with the calibration geometry. Retry, or continue without gaze (confusion still works).
6. **Done:** a three-line "how it works", then the app lives in the menu bar or tray (Help me now, Pause/Resume, Recalibrate, Quit).

Storage is a JSON file in the app's user-data folder (`ojos-store.json`). It holds settings, the chosen display and calibration profiles, and never leaves the laptop.

**Gaze source.** `src/renderer/src/setup/gazeSource.ts` receives raw WebEyeTrack and ETH-XGaze observations from the local capture process. It maps their timestamps onto the clock used to display calibration targets.

**Geometry.** The camera ID and size come from the opened track. The encoded viewport fits the selected display into at most 1920 × 1080 pixels with even dimensions and a preserved aspect ratio. Recording and calibration both use those dimensions.



[prototypes/doodle/](../) uses Electron + electron-vite + React + TypeScript and targets macOS and Windows.

See the [desktop instructions](../README.md) for dependencies, local startup, and packaging.

| Key (Ctrl on Windows) | Action |
| --- | --- |
| Cmd+Shift+O | Ask about the last 20 seconds |
| Option/Alt+1, 2, 3 | Pick a suggested question (only while the mascot is showing) |
| Cmd+Shift+X | Dismiss |
| Cmd+Shift+Q | Quit |

| Path | Role |
| --- | --- |
| `src/shared/commands.ts` | Contract types (source of truth for the tables below) |
| `src/main/index.ts` | Overlay window, hotkeys, nudge → suggest → explain flow, run cancellation |
| `src/main/gemini.ts` | Selected-question prompt and stream parser |
| `src/main/capture/service.ts` | Capture lifecycle, local vision workers, and clip export |
| `src/renderer/src/components/Nudge.tsx` | Mascot and question pills |
| `src/renderer/src/components/Panel.tsx` | Answer panel |
| `src/renderer/src/components/Logo.tsx` | "ojos" wordmark |
| `src/renderer/src/doodle/engine.ts` | Doodle pen animation, kept outside React |

## Contract with the explainer

The [clip assistant](../../../agentic_system/assistant/README.md) returns question suggestions. The selected-question explainer uses one frame from the same clip and an optional calibrated gaze point. Overlay coordinates are normalized to 0–1000 with a top-left origin.

**1. Suggest** (fast model, default `gemini-4-hydrogen`). Starts as soon as the mascot appears. Returns JSON:

```json
{
  "stuck_on": "the TypeError on line 14",
  "questions": ["Why is user None here?", "What does this TypeError mean?", "How do I fix get_user()?"],
  "summary": "get_user() returned None, so reading user['name'] fails."
}
```

| Field | Shown as | Notes |
| --- | --- | --- |
| `stuck_on` | Not shown yet | Noun phrase naming the actual thing on screen, 7 words or fewer. Available for the answer panel or logging |
| `questions` | Question pills with ⌥1–3 | At most 3, each 8 words or fewer, specific to what's on screen. Empty leaves only "Explain what I'm looking at" |
| `summary` | Not shown yet | Optional gist of the answer; matches the AI-system pipeline's summary output |

On error the overlay shows only the "Explain what I'm looking at" pill.

**2. Explain** (stronger model, default `gemini-4-neon`). Called with the chosen question, or none for a generic explanation. Streams newline-delimited JSON, one command per line, applied in order:

```json
{"title": "Why is user None on line 14?"}
{"say": "get_user() on line 12 returns None when no user matches the ID."}
{"say": "Line 14 then reads user['name'], which fails on None."}
{"say": "Check for None before using the result."}
```

| Command | Fields | Notes |
| --- | --- | --- |
| `title` | `title` | The question being answered. Sent first |
| `say` | `say` | One short sentence, typed into the panel. 2–5 per answer |
| `draw` | see below | Doodles only. Skipped unless enabled |

Draw commands accept an optional `color` of `red`, `blue`, `green` or `yellow`:

| `draw` | Fields | Notes |
| --- | --- | --- |
| `circle` | `box: [x1, y1, x2, y2]` | Loose hand-drawn ellipse around the box |
| `underline` | `from`, `to` | Slightly wavy line |
| `arrow` | `from`, `to` | Curved, head at `to` |
| `highlight` | `box` | Translucent marker swipe |
| `label` | `at`, `text` | Handwritten, 2–4 words, in empty space |

Each `draw` should come before the `say` that refers to it. Unknown or malformed lines are skipped. Over SSE, send each command as one `data:` line.

## Integration points

- **Confusion events:** call the same path as the hotkey (`nudge()` in `src/main/index.ts`) when `interval.finalized` arrives. The model runs in Python, so the simplest bridge is a JSON line per event over stdout or a local socket. Agree on the format with the ML side.
- **Gaze:** use the latest valid `gaze.sample` at event time, normalized to 0–1000. It's used to pick which paragraph or element the questions are about, and it drives the mascot's pupils. It never selects pills: the tracker is far too noisy for that, and choosing is the user's explicit opt-in.
- **Screen capture:** replace `captureScreen()` with Victor’s `Recorder` from [`agentic_system/capture/recorder.cjs`](../../../agentic_system/CAPTURE.md), run in Electron main. A hidden renderer feeds it frames of the selected display. On a confusion event, call `interval(event, nowUs)` (or `manual(nowUs)` for "Help me now") and `writeBundle(clip, folder)` to get `video.mp4`, `manifest.json` and `gaze.json`. Export needs FFmpeg on `PATH`.
- **Backend, suggest step.** Send the bundle to the [clip assistant](../../../agentic_system/assistant/README.md) and map its result onto `Suggestions`.

  | Backend field | Overlay field |
  | --- | --- |
  | `suspected_confusion` | `stuck_on` |
  | `possible_questions` | `questions` |
  | `summary` | `summary` |

  The desktop starts the backend on loopback with a bearer token. `POST /v1/jobs` takes `manifest`, `gaze` and `video`. The three fields arrive in `job.analysis` on `GET /v1/jobs/{job_id}/events`.
- **Backend, explain step.** After a user picks a question, `streamGemini` streams `title` and `say` commands from Electron main.

## Open items

- Test real Gemini: model access for `gemini-4-hydrogen` and `gemini-4-neon` on our keys, suggestion latency, question quality.
- Confirm clicks register on the non-focusable overlay on macOS. The ⌥1–3 shortcuts work either way.
- Check whether screen recorders capture the overlay (content protection may hide it from the demo video). Add a switch if needed.
- Test on Windows, including mixed-DPI setups.
- Doodles: verify placement accuracy before enabling them in the demo.
