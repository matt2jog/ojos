# Ojos desktop overlay

The draggable companion opens on the selected display when the recording worker confirms a confusion interval. The clip assistant suggests up to three questions. Pick a suggestion, press its shortcut, or click the mascot for a general explanation. A fresh selection opens a chat grounded in that clip. The composer sends follow-ups in the same chat, and **Open last chat** in the tray restores the saved conversation.

The overlay is transparent and always on top. Only the companion and its controls take clicks. During capture, the desktop excludes the overlay or hides it while reading the display, depending on the platform. Start with `--doodles` to enable optional ADK drawing commands on the display.

## Setup and controls

First-run setup handles permissions, display selection, and optional gaze calibration. It uses the same capture geometry and local tracker observations as the recording session. From the tray, use **Run setup again…** or **Recalibrate eyes…** to repeat setup.

| Shortcut | Action |
| --- | --- |
| Cmd/Ctrl+Shift+O | Ask about the last 20 seconds |
| Option/Alt+1, 2, or 3 | Pick a suggested question |
| Cmd/Ctrl+Shift+X | Dismiss the companion |
| Cmd/Ctrl+Shift+Q | Quit |

## Code and contracts

| Path | Role |
| --- | --- |
| `src/main/index.ts` | Owns the overlay, chat lifecycle, and confusion routing |
| `src/main/capture/service.ts` | Owns recording, clip export, and gaze overlap checks |
| `src/main/assistant.ts` | Starts the local ADK service and streams chat events |
| `src/renderer/src/components/Companion.tsx` | Renders the mascot, suggestions, and chat |
| `src/shared/commands.ts` | Defines shared overlay messages |

The clip and chat routes are documented alongside the capture and gaze contracts. [Shared protocol](../../../docs/protocol.md) · [Assistant service](../../../agentic_system/assistant/README.md) · [Desktop startup and packaging](../README.md)
