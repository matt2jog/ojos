# Gemini replay smoke check

Run from the repository root. Generate the synthetic replay into a fresh folder, then validate its job files locally. The runner uses Python 3.10+ and the standard library. The fixture generator needs FFmpeg and FFprobe.

```sh
fixture_dir="$(mktemp -d)/fixture"
python3 testing/screen-sync-lab/media/generate.py --output-dir "$fixture_dir"
python3 testing/screen-sync-lab/gemini/smoke.py "$fixture_dir"
```

The smoke runner validates `manifest.json`, `gaze.json`, and `video.mp4` and prints the request size, clip duration, clip-relative event bounds, and valid gaze count. The first fixture should report a 15,000,000 μs clip, the event `[10000000, 14000000)` μs, and 1 valid gaze sample out of 75. The media generator verifies the actual clip timing and streams. The smoke runner checks the MP4 file type and size plus the timing and geometry declared in the JSON.

To try the provider with this generated fixture, supply `GEMINI_API_KEY` through your environment and add `--send`. Use `--model` to override `gemini-3.6-flash`.

```sh
python3 testing/screen-sync-lab/gemini/smoke.py "$fixture_dir" --send
```

`--send` makes one Gemini Interactions request with the synthetic MP4 inline, the clip-relative metadata in a separate input part, no tools, and `store: false` to disable stored interaction state. The full JSON request must stay under 20 MB including base64. The runner accepts only manifests marked `replay`. Use the generated synthetic media because a manifest cannot establish where an arbitrary video came from. [Inline video](https://aistudio.google.com/docs/video-understanding#inline-video) · [Interactions storage](https://aistudio.google.com/docs/interactions-overview#data-storage-retention)

A successful send prints the validated version 1 result from [the shared protocol](../../../docs/protocol.md). Evidence times must land within the half-open clip range. Compare the answer with the visible `items[3]` example to evaluate grounding. Gemini samples video frames by default, so use the media generator’s verification for short flash and tone alignment. [Structured output](https://aistudio.google.com/docs/structured-output) · [Video processing modes](https://aistudio.google.com/docs/video-understanding#agentic-video-understanding)
