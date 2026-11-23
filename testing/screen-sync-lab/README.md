# Screen-sync lab

The lab exercises the first fixture in the [shared protocol](../../docs/protocol.md). It covers delayed interval delivery, screen-frame lookup, export bounds, and gaze alignment.

## Timing and gaze replay

Run these commands from this directory with Python 3.9 or later. The replay uses the standard library.

```sh
python3 replay.py
python3 replay.py --json
python3 -m unittest -v
```

| Session time | What happens |
| --- | --- |
| 4.0 s | The first retained screen keyframe starts the clip. |
| 9.4 s | The fixation selects screen frame 141. |
| [14.0, 18.0) s | The vision interval covers this range. |
| 19.0 s | The clip ends and the media fixture switches to a different question. |
| 19.2 s | The finalized interval arrives. The screen is now on frame 288. |

Frame lookup uses the observation time. A target one microsecond before the fixation selects frame 140 at 9.333333 s. Removing frame 141 makes the target fall into a screen gap, so the lookup returns `screen_frame_gap`. An observation older than the ring returns `no_prior_frame`.

The clip keeps the interval separate from its actual bounds of `[4 s, 19 s)`. Exported gaze starts at clip zero on the 200 ms grid. At clip time 5.4 s, interpolation across an 80 ms source interval yields `(941.2, 382.5)` with a 114 px uncertainty radius. At clip time 5.8 s, a 400 ms source gap yields `valid: false` and null coordinates and uncertainty. The replay interpolates only across valid samples less than 100 ms apart. That cutoff is local to the lab. Diagnostic reasons stay in the replay output, and a clip with no valid gaze exports an empty sample list.

A separate geometry example crops a 1920 × 1080 rectangle at `(320, 180)` from a 2560 × 1440 display. Normalized gaze `(0.75, 0.5)` then maps to `(800, 270)` in a 960 × 540 encode and to `(270, 800)` in a 540 × 960 encode after a clockwise 90° rotation. The crop origin is local capture metadata. Protocol v1 carries encoded viewport coordinates.

## Playable fixture and Gemini smoke check

- [Media generator](media/README.md) builds the synthetic source, exports the 15-second MP4, and verifies the flash and tone near the 5.4-second gaze marker.
- [Gemini smoke check](gemini/README.md) validates the generated job files locally and documents the optional provider request.

The Python replay uses a prealigned synthetic clock and frame metadata. Clock alignment across real processes, native capture, eye calibration, live ring integration, and pane replacement still need desktop integration tests.
