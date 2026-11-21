# Ojos desktop overlay

The draggable companion opens on the selected display when the recording worker confirms a confusion interval. The clip assistant suggests up to three questions. Pick a suggestion, press its shortcut, or click the mascot for a general explanation. A fresh selection opens a chat grounded in that clip. The composer sends follow-ups in the same chat.

**Saved chats** under the avatar or in the tray opens a list of past conversations with their titles and descriptions. Select one to resume its transcript and memory. The active menu pill expands to show the chat title or **Chat list**.

If a new confusion interval overlaps an open chat with a completed answer, the pane offers **Explain it another way**. Clicking it asks a follow-up in the same conversation. The desktop checks the visible pane against the gaze box scaled to 75% of its width and height about its center. At least two samples in the last 1.6 seconds of the interval must exceed the IoU threshold. Set `OJOS_CHAT_GAZE_IOU` to tune it from its default of `0.08`.

When a confusion interval points outside the pane, Ojos blurs the visible conversation and offers questions about the new screen context. **Keep current chat** dismisses the offer. Choosing a question starts a separate chat with its own memory and leaves the previous chat in **Saved chats**.

The overlay is transparent and always on top. Only the companion and its controls take clicks. The desktop requests capture exclusion for the overlay. Start with `--doodles` to enable optional ADK drawing commands on the display.

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
