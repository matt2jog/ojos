# Ojos live-doodle prototype

Tests the overlay idea: when you're "stuck", hand-drawn marks animate live on your real screen and a side panel explains what's going on. No ML here. A hotkey pretends you've been confused for about 3 seconds, and the mouse pointer stands in for gaze.

Stack: Electron + electron-vite + React + TypeScript. Works on macOS and Windows.

## Run

```bash
npm install
npm run mock     # scripted doodles around your pointer, no API key needed
npm run dev      # real Gemini: screenshot + pointer position -> streamed drawings + explanation
```

For `npm run dev`, create `.env` in this folder (it's gitignored):

```
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-4-hydrogen   # optional, swap to compare models
```

With no `GEMINI_API_KEY`, the app falls back to mock mode.

On macOS, the first real run needs **Screen Recording** permission for Electron (System Settings → Privacy & Security → Screen Recording). Restart after granting it; until you do, screenshots only show the wallpaper.

## Use

| Key (Ctrl on Windows) | Action |
| --- | --- |
| Cmd+Shift+O | "I'm stuck". Point the mouse at the confusing thing first |
| Cmd+Shift+X / "Got it" button | Dismiss (doodles fade out) |
| Cmd+Shift+Q | Quit |

A pill at the bottom of the screen confirms the app started. Clicks pass through to your apps; only the panel is clickable.

## Layout

| Path | What |
| --- | --- |
| `src/shared/commands.ts` | **The drawing contract**: `title`, `say`, `draw` (circle, underline, arrow, highlight, label), coordinates 0–1000 |
| `src/main/index.ts` | Overlay window, hotkeys, screenshot, run cancellation |
| `src/main/gemini.ts` | Prompt + streaming parser (moves to the Python backend later) |
| `src/main/mock.ts` | Scripted demo |
| `src/renderer/src/doodle/engine.ts` | Canvas pen animation (plain TS, runs outside React for 60fps) |
| `src/renderer/src/App.tsx` | Wires IPC → engine and panel state |
| `src/renderer/src/components/` | `Panel`, `DoodleCanvas`, `ReadyToast` |

Commands are processed in order, so text and drawings stay in sync. Each `say` types out after the drawing before it finishes.
