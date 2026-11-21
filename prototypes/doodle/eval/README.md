# Ojos desktop AI and benchmark

## How the live desktop uses Gemini

The existing confusion event opens a nudge. Electron main sends one screenshot and the approximate focus point to Gemini 4 Hydrogen. The nudge asks for one visible task, a short piece of screen evidence, and up to three distinct questions. A missing or unclear task leaves the existing generic help affordance available. Tracked gaze, manual pointer position, and unavailable gaze are distinct inputs. Screenshot text is treated as reference material.

Picking a question opens one streamed answer using the nudge screenshot. A typed question uses a fresh screenshot and takes priority over gaze. The assistant keeps up to four completed turns in memory and sends the opening screenshot again only for an explicit reference to the first image. The renderer receives the existing title, text, and optional doodle commands after runtime validation. Dismissal, replacement, and deadlines stop the client from consuming stale output. The Gemini SDK may still bill work already received by the service.

Hydrogen runs at low thinking for both stages by default. Set `GEMINI_MODEL=gemini-4-neon` to use Neon for explanations. `GEMINI_SUGGEST_MODEL` independently controls the nudge. The model call and request policy live in `src/main/gemini.ts`. The vision event, capture, UI, and IPC continue through the team's Electron application.

## Baseline versus shipped candidate

Both variants used the same eight synthetic screen/gaze scenarios. Each row has one sample per scenario per variant. Latency starts at the assistant request and excludes screen capture and renderer animation. Cost uses Gemini's published standard paid rates for input and generated tokens, including thinking. It is an estimate and does not reflect the hackathon account's invoice or credits. [Gemini Developer API pricing](https://aistudio.google.com/docs/pricing)

| Metric | Desktop baseline | Candidate |
| --- | ---: | ---: |
| Successful live calls | 8/8 | 8/8 |
| Median nudge result, five cases | 5.65 s | 4.07 s |
| Median time to first streamed answer text, three cases | 7.33 s | 2.48 s |
| Median complete answer, three cases | 7.71 s | 2.75 s |
| Input tokens across eight cases | 12,280 | 12,382 |
| Generated and thinking tokens across eight cases | 7,760 | 3,503 |
| Standard paid-rate estimate across eight cases | $0.1054 | $0.0448 |
| Scripted regression checks | 1/7 | 7/7 |

The baseline suggested refresh and troubleshooting questions for an empty tab. The candidate returned an empty question list. On the osmosis page with an embedded instruction aimed at Ojos, the baseline made the directive itself the topic and repeated its marker in a question. The candidate asked about osmosis. On the changed worksheet, both correctly explained that AVERAGE ignores text in a range. The candidate made the same observation with one screenshot and 1,378 input tokens, down from two screenshots and 2,488 tokens.

The candidate's suggestions on the seating exercise highlighted the clue about Ren and Priya without giving away the full order in the summary. Both variants handled the typed spreadsheet error despite gaze on the adjacent dice pane. One candidate summary used imprecise phrasing about the denominator of AVERAGE. Its explanation correctly gave the count of numeric cells as the divisor.

These are direct observations from synthetic examples. The sample is too small to estimate general intent accuracy, injection resistance, or production latency. The benchmark does not score hidden learner intent or optional live doodle placement. [Blind human review](blind-review.md) contains complete paired outputs. [Request measurements](measurements.jsonl) include all 35 responses and usage.

## Five experiments

| Change tested | Result | Decision |
| --- | --- | --- |
| Require visible evidence and allow a nudge to abstain (`48081de`) | Blank and embedded-instruction cases improved on live Hydrogen. Median nudge fell from 5.65 s to 4.96 s in this run. The schema and instructions increased input usage. | Keep. |
| Make typed intent authoritative and bound history (`b262e61`) | The changed-screen case dropped one screenshot and 1,110 input tokens. All three chat cases remained correct on Neon. Median first text was 8.06 s, compared with 7.33 s in the baseline run. | Keep for context and upload reduction. |
| Validate the command stream (`ad9430c`) | Scripted replays discarded invalid drawing coordinates and mixed commands, preserved a valid doodle, and returned a readable fallback for an empty stream. | Keep. |
| Set low thinking on Hydrogen and Neon (`1243154`) | In the first eight-case run, median nudge fell to 3.63 s and first answer text on Neon to 5.73 s. | Keep for the two tested models. |
| Try Hydrogen for explanations (`1243154` with an override, then `a4fb699` as default) | Same three chat cases stayed correct. Median first text was 2.32 s on the first run and 2.48 s on the full repeat. | Ship Hydrogen as default. Keep the model override for different workloads. |

## Reproduce

From `prototypes/doodle`, use Node 24 and `npm ci`. The baseline pins the Electron team's last pre-experiment desktop commit, `f5275ae`. The runner uses the real Gemini SDK and application entry points. Offline replies enter through mocked HTTP. The live mode sends only the checked-in synthetic PNGs. Set `GEMINI_API_KEY` through the environment or Node's `--env-file`. Keep it out of Git.

```sh
node eval/run.mjs --variant baseline
node eval/run.mjs
node eval/run.mjs --variant baseline --live --max-requests 8
node eval/run.mjs --live --max-requests 8
npm run typecheck
npm run build
```

Results are written under `.eval/`. Use `--case <id>` for a single scenario and `--variant <commit>` for a recorded experiment. [Case list and review criteria](cases.json)

On macOS arm64, the built Electron app also passed a manual smoke run with its existing mock and a separate native screen-capture run with a loopback Gemini stub. The latter verified the same capture for nudge and picked question, a fresh capture for typed chat, and the prior completed answer in the follow-up request. Live Gemini was measured separately on synthetic screens. The existing Python assistant and replay suites passed 24 tests. Webcam-triggered and real-screen Gemini behavior remain to be checked on the demo setup.
