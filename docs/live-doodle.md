# Live doodle overlay

When the user has been stuck for about three seconds, Ojos draws on their real screen. Hand-drawn circles, arrows, underlines and labels animate stroke by stroke over the thing they're looking at, while a side panel explains what's going on. The user never types or says the question; Ojos works it out from their face, their gaze and the screen. [Shared protocol](protocol.md) · [Prototype](../prototypes/doodle/)

## What the user sees

1. They stare at something confusing, such as an error message, a formula or a UI they don't understand.
2. A rainbow glow appears around the screen edges and a panel slides in on the right.
3. Marks draw themselves on top of the real screen (not a screenshot): a red circle around the problem, an arrow to its cause, a handwritten label. The panel types out the explanation in step with each mark.
4. They press "Got it", or the confusion score drops, and everything fades out.

The overlay is a transparent, always-on-top, click-through window, so the apps underneath stay usable. Only the panel takes clicks. The overlay is excluded from screen capture so Gemini never sees its own drawings.

## Prototype status

[prototypes/doodle/](../prototypes/doodle/) is Electron + electron-vite + React + TypeScript and targets macOS and Windows.

```bash
cd prototypes/doodle
npm install
npm run mock   # scripted doodles, no key
npm run dev    # real Gemini; needs GEMINI_API_KEY in prototypes/doodle/.env
```

Press Cmd/Ctrl+Shift+O to trigger and Cmd/Ctrl+Shift+X to dismiss. The trigger and gaze are faked: the hotkey stands in for a confusion event, and the mouse pointer stands in for gaze. The main process currently calls Gemini directly with one model; that call moves to the backend (see below).

| Path | Role |
| --- | --- |
| `src/shared/commands.ts` | Drawing command contract (source of truth for the types below) |
| `src/main/index.ts` | Overlay window, hotkeys, screenshot, cancellation of stale runs |
| `src/main/gemini.ts` | Current prompt and stream parser, to be moved to the backend |
| `src/renderer/src/doodle/engine.ts` | Canvas pen animation, kept outside React for smooth frames |
| `src/renderer/src/App.tsx` | Routes commands to the engine and panel |

## Drawing command contract

The explainer emits newline-delimited JSON with one command per line, in display order. The overlay processes commands sequentially, so a `say` appears after the `draw` before it finishes. Interleave them: draw, then say what it shows.

```json
{"title": "Why is user undefined here?"}
{"draw": "circle", "box": [412, 388, 590, 412], "color": "red"}
{"say": "This line reads 'name' from user..."}
{"draw": "arrow", "from": [430, 380], "to": [300, 250], "color": "blue"}
{"say": "...but get_user() up here returned nothing."}
{"draw": "label", "at": [310, 230], "text": "returns None!", "color": "blue"}
```

| Command | Fields | Notes |
| --- | --- | --- |
| `title` | `title` | The question the user probably has, at most 8 words. Sent first |
| `say` | `say` | One short sentence, typed into the panel |
| `circle` | `box: [x1, y1, x2, y2]` | Loose hand-drawn ellipse with padding around the box |
| `underline` | `from`, `to` | Slightly wavy line |
| `arrow` | `from`, `to` | Curved, head at `to` |
| `highlight` | `box` | Translucent marker swipe, yellow by default |
| `label` | `at`, `text` | Handwritten text, 2–4 words, placed in empty space |

All drawing commands accept an optional `color` of `red`, `blue`, `green` or `yellow` (red by default). Coordinates are integers on a 0–1000 scale across the captured display, with the origin at top left. The overlay maps them to its own size, so Retina and Windows DPI scaling don't affect the contract. The screenshot sent to Gemini must be of the same display the overlay covers, uncropped. Unknown or malformed lines are skipped.

## Integration points

**Trigger and gaze (vision).** The overlay opens on `interval.finalized` and uses the latest valid `gaze.sample` as the focus point. Both are defined in [protocol.md](protocol.md). The gaze worker on `ml/eye-tracking` runs in JavaScript and can be hosted by the Electron renderer. Normalize gaze to 0–1000 of the viewport before sending it to the explainer. Keep the hotkey trigger as well, plus a dwell trigger (gaze held in one area for 3 s or more), because the confusion baseline still misses most confusion clips.

**Explainer (backend).** The backend replaces `src/main/gemini.ts`. It takes the screenshot (and later the clip), the gaze point and the event window, and streams commands back. Over SSE, send each command as one `data:` line. The desktop app treats SSE output exactly like the current stream.

Planned two-model split:

| Role | Model | Emits |
| --- | --- | --- |
| Artist | `gemini-4-hydrogen` (fast) | `draw` commands only, so the first stroke appears quickly |
| Teacher | `gemini-4-neon` (Carbon as an alternative) | `title` and `say` |

If both run in parallel, the backend merges them into one ordered stream: hold each `say` until the `draw` it refers to has been sent. Simplest version: have the Teacher reference draw indices, or run the Artist first and give its output to the Teacher.

**Dismissal.** The overlay closes on "Got it", Cmd/Ctrl+Shift+X, or a sustained drop in confusion score (to be wired up). If the user still looks confused about 10 s after the explanation finishes, request a second attempt and pass the first one along so the explainer tries a different angle.

## Open items

- Check draw accuracy with real Gemini: do circles land on the intended element? If not, add the gaze crop as a second image or fall back to highlighting the gaze region.
- Test on Windows, including mixed-DPI multi-monitor setups.
- Clear the doodles when the user scrolls or switches windows, since the marks no longer line up.
- Add real frosted glass for the panel: put it in its own window with `vibrancy` on macOS or `backgroundMaterial: 'acrylic'` on Windows 11.
- Package as .dmg / .exe for judges.
