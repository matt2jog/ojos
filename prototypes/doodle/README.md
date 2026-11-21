# Ojos overlay prototype

The desktop overlay for Ojos. When the user might be stuck, a mascot slides in with suggested questions. One click or keypress shows a short answer in a side panel. Optional live doodles can draw on the real screen. Design, contract and integration points: [docs/overlay.md](docs/overlay.md).

Stack: Electron + electron-vite + React + TypeScript. Works on macOS and Windows.

## Run

```bash
npm install
npm run mock            # canned questions and answer, no key needed
npm run mock:doodles    # same, plus live doodles
npm run dev             # real Gemini (two models: suggest, then explain)
npm run dev:doodles
```

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
| Cmd+Shift+X | Dismiss |
| Cmd+Shift+Q | Quit |

A pill at the bottom of the screen confirms the app started. Clicks pass through to your apps except on the mascot, pills and panel.
