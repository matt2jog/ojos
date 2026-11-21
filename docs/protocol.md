# Shared protocol

The vision worker and desktop share this version 1 contract. The vision worker publishes intervals and gaze. The desktop owns the clock, clip export, and upload. Vast owns Gemini requests and returns results to the pane that opened the job. Both developers can integrate against the replay example below.

## Session and time

- Create a UUID `session_id` when the user starts recording on a selected display. Use the desktop main process's monotonic clock to define time zero. All `*_us` values are nonnegative integer microseconds. Time ranges are half-open, `[start_us, end_us)`.
- At worker start, align its monotonic clock to the main process with a ping and a worker timestamp. Estimate offset from the midpoint of the lowest-round-trip sample in a short series. Relate platform media timestamps to that worker clock at the source. IPC arrival time is for latency measurement. Use a fresh epoch after sleep, source restart, or a clock discontinuity.
- `capture_epoch` starts at zero and increases whenever the source, geometry, or timeline changes. A clip uses one epoch. Flush old ring data, reset vision state, and refresh gaze calibration when its camera or display geometry changes.
- Gaze is measured in the encoded viewport, with top left at `(0, 0)`, x increasing right and y down. Map from the selected display's normalized coordinates to the recorded dimensions, including any orientation transform. Keep desktop-global offsets and logical display units out of the payload. Coordinates cover the whole viewport, including the toolbar and borders.

## Vision to desktop

One `interval.finalized` message is emitted for each eligible interval. The desktop also consumes `gaze.sample` messages continuously, keeping only the history needed by its ring. Worker messages use the active session and epoch. Ignore stale messages after a restart or a display change.

```json
{
  "type": "interval.finalized",
  "schema_version": 1,
  "session_id": "77510d91-432d-4c51-b2e6-59cb27986589",
  "capture_epoch": 0,
  "event_id": "d8731f55-4642-41ce-aeed-e0ca50283c54",
  "source": "live",
  "start_us": 14000000,
  "end_us": 18000000,
  "first_frame_id": 112,
  "last_frame_id": 143,
  "score": 0.82,
  "model_version": "confusion-demo-1"
}
```

`source` is `live` or `replay`. Frame IDs are increasing integers local to the camera stream within an epoch. Bounds identify the first and last contributing frames inclusively. `score` is the peak smoothed confusion score in the interval. A manual trigger is created by the desktop and has no vision event or model score. Camera frames and frame IDs are kept local.

```json
{
  "type": "gaze.sample",
  "schema_version": 1,
  "session_id": "77510d91-432d-4c51-b2e6-59cb27986589",
  "capture_epoch": 0,
  "time_us": 9400000,
  "x_px": 941.2,
  "y_px": 382.5,
  "uncertainty_radius_px": 114,
  "valid": true
}
```

`time_us` here is session-relative. The producer uses the encoded dimensions supplied by the desktop. Missing gaze has `valid: false` with both coordinates and uncertainty set to `null`. Valid points are finite, inside the encoded bounds, and have nonnegative uncertainty. A capture epoch without usable calibration can produce an empty gaze history.

## Desktop to backend

`POST /v1/jobs` uses a bearer token and `multipart/form-data` with three parts. `manifest` and `gaze` are UTF-8 JSON. `video` is a playable `video/mp4`. The demo cap is 32 MiB. The `manifest` remains version 1. New desktop builds use gaze sidecar version 2, described below.

```json
{
  "schema_version": 1,
  "session_id": "77510d91-432d-4c51-b2e6-59cb27986589",
  "capture_epoch": 0,
  "event_id": "d8731f55-4642-41ce-aeed-e0ca50283c54",
  "source": "live",
  "event_start_us": 14000000,
  "event_end_us": 18000000,
  "clip_start_us": 4000000,
  "clip_end_us": 19000000,
  "viewport_width_px": 1920,
  "viewport_height_px": 1080,
  "audio_status": "present",
  "gaze_status": "available"
}
```

- `source` is `live`, `replay`, or `manual`. For manual requests, use the requested lookback start and trigger time, clipped to the current epoch and the available ring.
- For automatic events, request `[event_start_us - 10000000, event_end_us + 1000000)`, clamped at epoch start. Begin on the preceding usable keyframe if present. Clip bounds report the actual retained media. Keep the initiating interval and actual clip bounds distinct, since the ring may have less pre-roll or post-roll than requested. Reject a payload when the interval and clip have no overlap.
- `audio_status` is `present` or `unavailable`. Silence through a healthy audio stream counts as present. An unavailable stream produces a video-only clip and a visible status. `gaze_status` is `available` if there is at least one valid exported point, otherwise `unavailable`.

```json
{
  "schema_version": 1,
  "samples": [
    {"time_us": 5400000, "x_px": 941.2, "y_px": 382.5, "uncertainty_radius_px": 114, "valid": true},
    {"time_us": 5600000, "x_px": null, "y_px": null, "uncertainty_radius_px": null, "valid": false}
  ]
}
```

This is the legacy single-tracker gaze sidecar. It uses a sorted 200,000 µs grid starting at clip zero and sends `samples: []` when gaze is unavailable. Keep version 1 decoding for existing replay fixtures.

### Gaze and confusion sidecar v2

`exportVisionSeries` in [`models/vision/index.mjs`](../models/vision/index.mjs) returns `{gaze_status, gaze}`. Place `gaze_status` in the manifest and send `gaze` as the multipart JSON part. The backend passes the same sidecar to Gemini with the clean screen and playback video. The backend can use the individual estimates, fused point and selected region alongside the confusion score. Evidence for an answer comes from the screen and playback audio.

```json
{
  "schema_version": 2,
  "timebase": "clip_relative_us",
  "step_us": 200000,
  "viewport_width_px": 1920,
  "viewport_height_px": 1200,
  "models": {
    "model1": "webeyetrack-blazegaze-75fbd2f-ridge-v1",
    "model2": "eth-xgaze-resnet50-epoch24-camera-plane-ridge-v1",
    "confusion": "confusion-devemo-plus-gru-8hz-1"
  },
  "samples": [{
    "time_us": 0,
    "confidence": 0.82,
    "confidence_raw": 0.91,
    "confidence_offset_us": -10000,
    "x_model1": 940, "y_model1": 382,
    "x_model2": 990, "y_model2": 405,
    "uncertainty_model1_px": 147, "uncertainty_model2_px": 142,
    "model1_offset_us": 0, "model2_offset_us": 10000,
    "average_x": 965, "average_y": 393.5,
    "maxbox": {"x": 793, "y": 235, "w": 339, "h": 312},
    "fusion_mode": "paired"
  }]
}
```

- `time_us` is measured from the actual first playable time of the MP4, including any keyframe lead-in. Sample offsets are signed microseconds relative to their row and preserve capture skew. Clip bins are half-open and spaced 200,000 µs apart. Every row is retained so scores survive if both gaze tracks are unavailable. Camera frames, landmarks, and calibration coefficients stay local.
- Gaze uses the nearest observation within 100 ms. An invalid nearest observation yields null fields for that tracker. An offline row may use an observation shortly after the grid time. Confusion uses the most recent valid score less than 250 ms old. Its nearest preceding invalid observation clears the score. `confidence` is the smoothed confusion softmax and `confidence_raw` is its raw value. The gaze radii are held-out residuals in pixels.
- Fuse when both observation timestamps differ by less than 100 ms. `average_x` and `average_y` are the arithmetic mean and `maxbox` is the smallest axis-aligned rectangle covering both padded estimates, clipped to the encoded viewport. Its origin is top-left and `w`/`h` are extents in pixels. The box serves as a region to inspect. It can span unrelated screen content when gaze estimates disagree widely.
- With one usable tracker, the average and box use that tracker. If both points are usable individually but too far apart in time, preserve both in the row and use model1 for the fused fields. `fusion_mode` is `paired`, `model1_only`, `model2_only`, or `unavailable`. With neither tracker, the coordinates, offsets, radii, average and box are null. The sidecar's confusion model ID can be null when the worker is disabled.
- Scope histories to the active session and capture epoch. The desktop uses the recorded clip start for the sidecar and rebases event bounds to the same clock before submitting the job. Do not send pixels from a crop of the display as though they belonged to the full viewport.

For a standalone fixture, run `node models/vision/replay.mjs models/vision/fixtures/handoff.json`. It emits a paired row, a single-tracker row, and an unavailable row that share a clip-relative clock.

## Backend to desktop

- On acceptance, return HTTP `202` and `{"job_id":"2e20ca6d-dd33-4bf6-8539-b4cb54c64df2"}`. Deduplicate on stable install identity, session ID, and event ID before admitting new work. Reuse the same job ID after a successful submission whose response was lost. A deliberate new request uses a new event ID.
- Open `GET /v1/jobs/{job_id}/events` with the same bearer token. Send named SSE events with increasing integer sequence numbers starting at 1 per job. Replay missed events using `Last-Event-ID`, then stream new events. The client deduplicates by sequence number within the job and checks its current pane before applying an update.
- Initial events are `job.status` with phase `accepted`, `uploading_to_gemini`, or `analyzing`, then `job.result` or `job.error`. Send a complete validated initial result in one event so the pane can match evidence to the answer.

```text
id: 4
event: job.result
data: {"schema_version":1,"status":"answered","likely_question":"Why does the command fail?","answer":"The shell is in the parent directory. Switch to the project directory before running the command.","evidence":[{"time_us":10500000,"detail":"The prompt shows the parent directory before the command."}]}

```

Result `status` is `answered` or `insufficient_evidence`. For insufficient evidence, use `likely_question: null`, a short explanation in `answer`, and `evidence: []`. Each evidence time is relative to clip zero and must fall inside the clip.

- `POST /v1/jobs/{job_id}/messages` takes `{"turn_id":"a-client-generated-uuid","text":"How can I confirm the folder?"}`. Return `202` and echo the turn ID. Deduplicate within the job. Process one active turn per job and send `turn.delta` events carrying `turn_id` and text, followed by `turn.result` with the complete answer or `turn.error` with a code.
- `DELETE /v1/jobs/{job_id}` cancels pending work and releases media. It is safe to repeat. A timed-out pane sends this request when possible. The backend also expires abandoned jobs and deletes media. `job.canceled` and `job.expired` close the stream. Every job, stream, and turn is accessible only to its issuing install.
- Errors carry `code`, `message`, and `retryable`. Return `400` for bad ranges or fields, `401` for an invalid credential, `404` for an unknown or foreign job, `410` for an expired job, `413` for oversized clips, and `429` for concurrency or quota limits. Report asynchronous provider failures as `job.error` or `turn.error`.

## Replay fixture specification

Make a fixture for each task type with a full-viewport, at least 25-second MP4, a JSON list of session-relative gaze samples, and an interval JSON file. Use a visible counter, a marked point in the viewport, and a same-time playback tone and flash. For the first fixture, play the tone and flash at 9.4 seconds and use the `[14 s, 18 s)` event above with `source: "replay"`. Use 1920 × 1080 with a keyframe at 4 seconds. A fixture runner releases media into the ring according to its timeline and emits events through the same desktop handlers as live callbacks.

Expect the first clip to cover `[4 s, 19 s)`. Its flash, tone, and corresponding gaze sample should all land near 5.4 seconds on the clip timeline. Add a second replay event while the first analysis is in progress to verify pane replacement and late-event rejection. Use a fresh session ID and event IDs per execution, and preserve those IDs across a retry within one execution.
