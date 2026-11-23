# Synthetic replay media

Run from the repository root with Python 3 and an FFmpeg build that includes
`ffprobe`, `libx264`, and the AAC encoder.

```sh
python3 testing/screen-sync-lab/media/generate.py
```

The generator prints its temporary output directory. Use `--output-dir PATH`
to choose a new directory. Each successful generation creates fresh session and
event UUIDs. For a retry of the same submission, reuse the files from that run.

| File | Contents |
| --- | --- |
| `source.mp4` | 25-second synthetic 1920 × 1080 recording at 15 fps, with a visible session counter and keyframes at 0, 4, and 19 seconds. |
| `interval.json` | v1 `interval.finalized` envelope for the session interval `[14 s, 18 s)`. |
| `session-gaze.json` | One v1 `gaze.sample` envelope at session 9.4 seconds, in a JSON list. |
| `manifest.json` | v1 job manifest with `source: "replay"` and actual clip bounds `[4 s, 19 s)`. |
| `gaze.json` | v1 job gaze payload with 75 points on the 200 ms grid. The only valid point is at clip 5.4 seconds, `(941.2, 382.5)` encoded pixels. |
| `video.mp4` | The playable 15-second MP4 for the v1 request, with a clip-relative timestamp origin. |

The Python Lists page asks “Why does items[3] raise IndexError?” A white flash
at the marked point and an 880 Hz tone run together from session 9.4 to 9.8
seconds. Both appear from 5.4 to 5.8 seconds in the clip. The Terminal page asks
“Which command shows the current directory?” and starts at session 19 seconds,
outside the export.

The generator checks stream dimensions, timestamps and durations with `ffprobe`.
It compares the hashes of all 225 exported H.264 packets with the source packets
in the half-open clip range. It decodes the marker pixels to locate the bright
frames and decodes AAC to check tone timing in 10 ms windows. Audio is re-encoded
after trimming to the clip’s exact sample boundaries.

This fixture exercises synthetic media export and v1 payload construction. The
desktop still needs a fixture runner that feeds its ring and event handlers, plus
native capture and pane replacement checks. All generated media and JSON stay
in the output directory.
