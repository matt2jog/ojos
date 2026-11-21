# Ojos workstream ownership

Read across workstreams to understand the handoffs, and keep edits within the workstream assigned in the current task. The [desktop and Gemini design](desktop-gemini.md) covers both Alejandro’s app and Victor’s assistant. Use the split below to determine ownership.

| Owner | Workstream | Owns |
| --- | --- | --- |
| Matt | Models | Webcam processing, model training and inference, stuck-moment detection and timing, and gaze estimation with MediaPipe. [Vision design](vision.md) |
| Alejandro | Desktop app (`prototypes/doodle/`) | The overlay that offers and displays help (mascot, suggested questions, answer panel, optional doodles), first-run setup and calibration screens, the tray, and wiring the recorder, vision signal and assistant into the app. [Overlay design](../prototypes/doodle/docs/overlay.md) · [Desktop design](desktop-gemini.md#desktop-process-layout) |
| Victor | Agentic AI and capture (`agentic_system/`) | The screen recorder module, rolling buffer and clip export. Interpreting the supplied context, choosing models and tools, designing prompts, and deciding what suspected confusion, questions and summary to return. [Workstream](../agentic_system/README.md) · [Assistant request flow](desktop-gemini.md#gemini-request-flow) |

## Handoff

1. Matt sends a timestamped possible stuck interval and gaze estimates when available.
2. Alejandro’s app passes the interval and gaze to Victor’s recorder, which runs inside the app’s main process. The recorder exports the matching clip, and the app sends the bundle to Victor’s assistant.
3. Victor’s assistant returns the suspected confusion, possible questions and a summary. Alejandro’s app shows the questions and answers the one the user picks.

Screen capture is shared work. Victor builds and tests the recorder as a standalone module in `agentic_system/capture/`. Alejandro owns its integration into the desktop app, including display selection and permissions. Until that is wired in, the overlay uses a single screenshot of the selected display as a stand-in.

Use the [shared protocol](protocol.md) for data formats and timing. If a task needs a change in another workstream or to the shared contract, flag it and coordinate with the affected owners before editing across the boundary. Use [replay inputs](protocol.md#replay-fixture-specification) or a stub to keep working within your area while the other parts are in development.
