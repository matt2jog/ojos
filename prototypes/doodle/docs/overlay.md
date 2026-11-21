# Ojos overlay (desktop UI)

This covers the desktop overlay: what appears on screen when the user might be stuck, how they ask for help without typing, and how the answer is shown. Alejandro owns it. Victor owns the screen recorder module and the Gemini backend in [`agentic_system/`](../../../agentic_system/README.md), and Matt owns the confusion and gaze models in [`models/`](../../../models/README.md). Wiring them into the app is part of the overlay work. This prototype stubs them for now so the UI can be built and demoed. [Shared protocol](../../../docs/protocol.md) · [Ownership](../../../docs/ownership.md) · [Prototype](../)

## Core rule

The user never has to type the question. Their face says *that* they might be stuck, their gaze says *what* they're stuck on, and one click (or keypress) says they actually want help. The confusion model also fires while people are just thinking hard, so Ojos never shows an answer unprompted.

## User flow (MVP)

1. **Confusion event:** the mascot appears near the right edge of the screen. It's a dark pill with two eyes and a Google-colored "j" nose, so the face reads "o j o". The pupils follow the pointer (gaze later), and it blinks. The rest of the screen stays untouched.
2. **Suggested questions:** a fast model reads the screenshot and gaze and guesses 2–3 questions specific to what's on screen. They show in a thought bubble above the mascot, one at a time, ending with "Something else? Just explain". The bubble moves to the next one every few seconds (hovering pauses it), and the dots and arrow under the text switch by hand. While loading, shimmer text shows and the nose's spark spins.
3. **Pick one:** click the question in the bubble, press its shortcut (⌥1/⌥2/⌥3, Alt on Windows; these work whichever question is showing), or click the mascot for a generic explanation. The eyes squint happily and a rainbow glow appears around the screen while the answer comes in.
4. **Answer:** the mascot stays, and its bubble becomes the conversation: the explainer streams a short text answer into it, with the chosen question shown as the user's chat message on the right and the answer below it.
5. **Follow up:** type in the box under the answer, or click one of the suggestions that were not asked yet (they keep showing one at a time above the box). Each follow-up is answered with the earlier turns as context and is added below them.
6. **Close:** the × under the mascot, or Cmd/Ctrl+Shift+X. Clicking the mascot hides or shows the bubble without ending the conversation.
7. **Ignored:** the mascot goes away after 15 s (hovering pauses this) and nothing is sent.

**Chat.** The chat button under the mascot opens the same conversation bubble with an empty thread, so the user can type their own question. Cmd/Ctrl+Shift+J and "Chat with Ojos" in the tray open it without a confusion event. The core rule still holds: typing is always optional.

**Moving it.** Drag the mascot by its face. The bubble opens above or below and to the left or right, toward whichever side has more room, and the position is remembered (`localStorage`).

A new confusion event during an open conversation does not close it. The new suggestions replace the ones above the chat box, and picking one continues the thread.

The overlay is a transparent, always-on-top, click-through window. Only the mascot and its bubble take clicks. It never takes keyboard focus, except while the user types in the chat box. It is excluded from screen capture.

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

**Gaze source.** `src/renderer/src/setup/gazeSource.ts` decides where calibration observations come from. On Matt's laptop it should be `VisionSession`'s `onObservation` (WebEyeTrack in a renderer worker, ETH-XGaze through `native_worker.py`). Everywhere else a simulated source turns the mouse into raw rows of the same shape, so the real fit, validation and saving all run. The screen shows a "simulated" tag in that case. Wiring the live source is the next integration step.

**Geometry.** The camera ID and size come from the opened 720p track. The display ID, scale and rotation come from Electron. The encoded viewport is physical pixels scaled down to at most 1920 wide, so the recorder must encode at the same size.



[prototypes/doodle/](../) uses Electron + electron-vite + React + TypeScript and targets macOS and Windows.

```bash
cd prototypes/doodle
npm install
npm run mock            # canned questions and answer, no key
npm run mock:doodles    # same, with doodles
npm run dev             # real Gemini; needs GEMINI_API_KEY in prototypes/doodle/.env
npm run dev:doodles
```

| Key (Ctrl on Windows) | Action |
| --- | --- |
| Cmd+Shift+O | Fake confusion event. Point the mouse at the confusing thing first |
| Option/Alt+1, 2, 3 | Pick a suggested question (only while the mascot is showing) |
| Cmd+Shift+J | Chat with Ojos |
| Cmd+Shift+X | Dismiss |
| Cmd+Shift+Q | Quit |

Stubs to replace: the hotkey stands in for confusion events, the mouse pointer for gaze, and a single `desktopCapturer` screenshot for the recorder. Gemini is called from the main process with the key in `.env`. That call moves to the backend before anything is packaged for others, so the key is never shipped.

| Path | Role |
| --- | --- |
| `src/shared/commands.ts` | Contract types (source of truth for the tables below) |
| `src/main/index.ts` | Overlay window, hotkeys, nudge → suggest → explain flow, conversation state, run cancellation |
| `src/main/gemini.ts` | Both prompts and the stream parser, to be moved to the backend |
| `src/main/mock.ts` | Canned questions and answer |
| `src/renderer/src/components/Companion.tsx` | Mascot, thought bubble, conversation and chat box, dragging |
| `src/renderer/src/components/Logo.tsx` | "ojos" wordmark |
| `src/renderer/src/doodle/engine.ts` | Doodle pen animation, kept outside React |

## Contract with the explainer

Two calls per confusion event. Both get the screenshot of the display the overlay covers (uncropped) and the gaze point. Coordinates are integers on a 0–1000 scale across that display, origin top left. Gaze is noisy, so prompts treat it as "within about 150 units of this point" and rely on the screenshot to find the exact paragraph, line or element.

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
| `questions` | Thought bubble, one at a time, with ⌥1–3 | At most 3, each 8 words or fewer, specific to what's on screen. Empty leaves only "Explain what I'm looking at" |
| `summary` | Not shown yet | Optional gist of the answer; matches the AI-system pipeline's summary output |

On error the thought bubble shows only "Explain what I'm looking at".

**2. Explain** (stronger model, default `gemini-4-neon`). Called with the chosen question, or none for a generic explanation. Streams newline-delimited JSON, one command per line, applied in order:

```json
{"title": "Why is user None on line 14?"}
{"say": "get_user() on line 12 returns None when no user matches the ID."}
{"say": "Line 14 then reads user['name'], which fails on None."}
{"say": "Check for None before using the result."}
```

| Command | Fields | Notes |
| --- | --- | --- |
| `title` | `title` | The question being answered. Sent first. Shown as the user's message only when the user did not pick or type a question |
| `say` | `say` | One short sentence, typed into the bubble. 2–5 per answer |
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

**Follow-ups** use the same call and the same output. The request then carries the conversation so far: the first screenshot with its question, each earlier answer, and the new question with a screenshot taken when it was typed (the screen may have changed). A suggestion picked from a later confusion event uses that event's screenshot. Only the first and the newest screenshot are sent. The main process keeps this history and drops it on dismiss.

## Integration points

- **Confusion events:** call the same path as the hotkey (`nudge()` in `src/main/index.ts`) when `interval.finalized` arrives. The model runs in Python, so the simplest bridge is a JSON line per event over stdout or a local socket. Agree on the format with the ML side.
- **Gaze:** use the latest valid `gaze.sample` at event time, normalized to 0–1000. It's used to pick which paragraph or element the questions are about, and it drives the mascot's pupils. It never selects pills: the tracker is far too noisy for that, and choosing is the user's explicit opt-in.
- **Screen capture:** replace `captureScreen()` with Victor’s `Recorder` from [`agentic_system/capture/recorder.cjs`](../../../agentic_system/CAPTURE.md), run in Electron main. A hidden renderer feeds it frames of the selected display. On a confusion event, call `interval(event, nowUs)` (or `manual(nowUs)` for "Help me now") and `writeBundle(clip, folder)` to get `video.mp4`, `manifest.json` and `gaze.json`. Export needs FFmpeg on `PATH`.
- **Backend, suggest step:** send the bundle to Victor’s [screen analysis backend](../../../agentic_system/assistant/README.md) and map its result onto `Suggestions`. Keep the direct Gemini call in `src/main/gemini.ts` as the fallback when the backend is unreachable or returns `insufficient_evidence`.

  | Backend field | Overlay field |
  | --- | --- |
  | `suspected_confusion` | `stuck_on` |
  | `possible_questions` | `questions` |
  | `summary` | `summary` |

  Locally the backend runs on loopback with a bearer token (`OJOS_LOCAL_TOKEN=ojos-demo python3 -m agentic_system.assistant serve`). `POST /v1/jobs` takes `manifest`, `gaze` and `video`, and the three fields arrive in the `job.analysis` event on `GET /v1/jobs/{job_id}/events`. `POST /v1/analyze` takes a `video` and a Matt-style `tracking` sidecar and returns the fields directly. `--provider scripted` tests the wire format without a key.
- **Backend, explain step:** the backend has no equivalent of the streamed `title`/`say` answer yet, so `streamGemini` stays in the app for now. The backend’s `summary` and evidence are available to seed or replace it once we decide how to show them.

## Open items

- Test real Gemini: model access for `gemini-4-hydrogen` and `gemini-4-neon` on our keys, suggestion latency, question quality.
- Confirm clicks register on the non-focusable overlay on macOS. The ⌥1–3 shortcuts work either way.
- Test typing in the chat box on macOS and Windows. The overlay becomes focusable only while the box is in use, and focus does not return to the previous app by itself when the box closes.
- Test follow-ups against real Gemini (only the mock has been run).
- Check whether screen recorders capture the overlay (content protection may hide it from the demo video). Add a switch if needed.
- Test on Windows, including mixed-DPI setups.
- Doodles: verify placement accuracy before enabling them in the demo.
