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

`POST /v1/jobs` uses a bearer token and `multipart/form-data` with three parts. `manifest` and `gaze` are UTF-8 JSON. `video` is a playable `video/mp4`. Cap the multipart body at 32 MiB for the demo.

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

Export a sorted 200,000 µs grid starting at clip zero, with points outside the reliable gaze history marked invalid. The example shows two entries from that grid. If gaze is unavailable for the clip, send `samples: []`. Evaluate each grid point at `clip_start_us + time_us` in the session history. Media and gaze use the same actual start, including any keyframe lead-in. Send relative event bounds to Gemini after intersecting the event with the exported clip.

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
