# Element 119 · Recovering vanished screen context

The demo contribution is the new screen look-back path, which recovers the visual cause of a problem after a notification, error, menu, or dialog has disappeared. The underlying mascot, screenshot assistant, vision trigger, and chat are the starting point. The working screenshot-only baseline is preserved at `25caf06`.

## What each Gemini service does

| Component | Job |
| --- | --- |
| Gemini 4 Hydrogen | Handles ordinary screenshot-based help and suggests questions when confusion is detected. |
| Gemini Decisions API · Decision 1 | Compares the current screenshot with up to three timestamped crops of earlier changes and ranks their relevance. High-confidence absence of evidence avoids a Neon call. |
| Gemini 4 Neon | Compares the earlier visual evidence with the current screenshot, names the exact change when readable, and streams a short next step. |

When screen look-back is enabled, Electron samples only the selected display about every 700 ms. It keeps a rolling 12 seconds in memory, up to 18 compressed frames. A pixel comparison proposes distinct regions. The latest region and the largest earlier changes compete for the three candidate slots. A look-back question sends the candidates to Decisions. Neon gets the chosen crop or, when the selection is uncertain, the candidate set. An ordinary answer uses one Gemini call. A look-back answer uses up to two. Nothing calls Gemini in the background to analyze the rolling screen buffer.

Display changes, Hide Ojos, setup, disabling the feature, and supported lock or suspend events clear the buffer. The retrospective generation requests set `store: false`. Screenshots used for visual reasoning are still sent to the Gemini API. [Decisions API image input](https://aistudio.google.com/docs/decisions-api#media)

## What broke and what changed

| Case | Screenshot baseline | First tool-calling prototype | Release |
| --- | --- | --- | --- |
| Same final sheet, earlier E412 date error | Could not recover code, 2.95 s to first text | Correct, 11.05 s | Correct, 5.74 s |
| Same final sheet, earlier E518 read-only error | Could not recover code, 3.10 s | Correct, 9.10 s | Offline regression passed. Live rerun pending. |
| Independent LibreOffice recording with moving presenter inset | Could not identify the vanished dialog, 3.01 s | Small recent changes crowded out the older dialog and a separate tool round trip timed out, 12.57 s to a fallback | Correctly identified Chart Type, Normal Column, and 3D Look off, 7.34 s |

All times are single-case measurements to the first streamed sentence. The controlled E412 and E518 replays start from byte-identical current screenshots. Only the previous frame changes. The LibreOffice replay used an eight-second window from independently authored 1080p footage. The presenter inset stayed in the frames and the soundtrack was omitted. The current frame is at 216 seconds. The recovered dialog frame is at approximately 209.5 seconds.

The first prototype asked Neon to choose a function call and then used another generation to answer. Moving video in the corner occupied much of the candidate set. The release groups overlapping change regions and reserves slots for larger changes. Decisions ranks the actual crops and the first Neon generation reads the evidence directly. In the independent replay, Decisions picked the older dialog with 0.606 confidence. Two live calls returned 200. The function round trip was removed after its live timeout.

The release is bounded by the sampling interval, the 12-second retention window, and text legibility. Short flashes can occur between samples. This replay does not establish an accuracy rate on unrehearsed inputs. The Electron native capture path was locally exercised with a disappearing dialog and verified crop decoding and expiry. Live provider calls used prerecorded public footage and controlled image cases.

[Live output and usage receipts](lookback-results.jsonl) · [Independent footage by DistroTube](https://commons.wikimedia.org/wiki/File:Creating_Charts_With_LibreOffice.webm) · [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)

## Live demo

1. Run the desktop app with a Gemini key and screen recording permission. Enable **Screen look-back (last 12 seconds)** from the tray or start using `npm run dev -- --lookback`.
2. Let a judge choose a dialog, setting, or transient warning to open in a real app on the selected display. Leave it visible for about two seconds, then dismiss it.
3. Open Ojos chat and ask **What changed on my screen?** within a few seconds. If using the confusion nudge, select the same question when it appears.
4. Have the judge verify the recovered name and setting. Repeat with a dialog dismissed after the buffer expires to show the system's evidence limit.

For playback and evidence collection, run from `prototypes/doodle` with Electron and FFmpeg installed. Download the licensed video from the source above to a local path. Keep credentials and private recordings local.

```sh
node_modules/.bin/electron eval/lookback.mjs
node_modules/.bin/electron eval/lookback.mjs --baseline --live --cap 1 --name libreoffice \
  --media /path/to/charts.webm --at 216 \
  --question 'What dialog was open on this screen just before now? Name it and say what was being configured.' \
  --expect 'Chart Type'
node_modules/.bin/electron eval/lookback.mjs --live --cap 2 --name libreoffice \
  --media /path/to/charts.webm --at 216 \
  --question 'What dialog was open on this screen just before now? Name it and say what was being configured.' \
  --expect 'Chart Type'
```

The archived early LibreOffice run had a loose substring check that counted a generic recommendation mentioning Chart Type. The final check requires historical media in the actual answer request and rejects an answer that says it could only see the current screen. Review exact recovered settings against the recording as well.
