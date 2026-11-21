# Ojos overlay prototype

The desktop overlay for Ojos. When the user might be stuck, a mascot appears with a thought bubble that shows one suggested question at a time. One click or keypress shows a short answer in the mascot's own bubble, where the user can follow up or chat. Optional live doodles can draw on the real screen. Design, contract and integration points: [docs/overlay.md](docs/overlay.md).

Stack: Electron + electron-vite + React + TypeScript. Works on macOS and Windows.

## Run

```bash
npm install
npm run mock            # canned questions and answer, no key needed
npm run mock:doodles    # same, plus live doodles
npm run dev             # real Gemini (two models: suggest, then explain)
npm run dev:doodles
```

To open Ojos without a terminal on macOS, run `npm run app` once. It builds the app and puts a double-clickable `Ojos.app` on the Desktop, which you can drag to the Dock. Re-run it after code changes. `npm start` builds and runs the same thing from a terminal, on macOS or Windows.

For `dev`, create `.env` here (it's gitignored):

```
GEMINI_API_KEY=...
GEMINI_SUGGEST_MODEL=gemini-4-hydrogen   # optional
GEMINI_MODEL=gemini-4-neon               # optional; use gemini-4-hydrogen if your key lacks Neon
```

With no key, the app falls back to mock mode. On macOS, the first real run needs **Screen Recording** permission for Electron (System Settings → Privacy & Security). Restart the app after granting it.

## Use

| Key (Ctrl/Alt on Windows) | Action |
| --- | --- |
| Cmd+Shift+O | Fake confusion event. Point the mouse at the confusing thing first |
| Option+1 / 2 / 3 | Pick a suggested question while the mascot is showing |
| Cmd+Shift+J | Chat with Ojos (opens the chat box) |
| Cmd+Shift+X | Dismiss |
| Cmd+Shift+Q | Quit |

First launch opens the setup window (permissions, display, eye calibration). Re-run it with `npm run dev -- --setup` or from the menu-bar icon. The menu-bar icon also has **Hide Ojos**, which takes the overlay off screen and stops it offering help without quitting.

Drag the mascot by its face to move it. It remembers where you left it.

Dev flags: `OJOS_USER_DATA=<dir>` uses a throwaway data folder; `--setup-step=<welcome|permissions|display|calibrate|done>` opens setup at a step; `--autopilot` runs calibration without camera or full screen; `--snapshot-setup=<file.png> --snapshot-delay=<ms>` saves a screenshot of the setup window and exits.

A pill at the bottom of the screen confirms the app started. Clicks pass through to your apps except on the mascot and its bubble. `--snapshot=<file.png>` saves a screenshot of the overlay and exits; add `--snapshot-do=<pick|followup|chat>` and `--snapshot-delay=<ms>` to capture a later state.
