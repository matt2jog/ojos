# Ojos workstream ownership

Read across workstreams to understand the handoffs, and keep edits within the workstream assigned in the current task. The [desktop and Gemini design](desktop-gemini.md) covers both Alejandro’s app and Victor’s assistant. Use the split below to determine ownership.

| Owner | Workstream | Owns |
| --- | --- | --- |
| Matt | Models | Webcam processing, model training and inference, stuck-moment detection and timing, and gaze estimation with MediaPipe. [Vision design](vision.md) |
| Alejandro | `protoype` and desktop app | The prototype, screen capture, matching the vision signal to screen context, and the popup and app UI that display help. [Desktop design](desktop-gemini.md#desktop-process-layout) |
| Victor | Agentic AI | Interpreting the supplied context, choosing models and tools, designing prompts, and deciding what hint, explanation, or clarifying question to return. [Assistant request flow](desktop-gemini.md#gemini-request-flow) |

## Handoff

1. Matt sends a timestamped possible stuck interval and gaze estimates when available.
2. Alejandro’s app uses the timestamps to package the relevant screen context and sends it to Victor’s assistant.
3. Victor’s assistant returns task-specific help for Alejandro’s app to display.

Use the [shared protocol](protocol.md) for data formats and timing. If a task needs a change in another workstream or to the shared contract, flag it and coordinate with the affected owners before editing across the boundary. Use [replay inputs](protocol.md#replay-fixture-specification) or a stub to keep working within your area while the other parts are in development.
