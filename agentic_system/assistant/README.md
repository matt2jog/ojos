# Ojos screen analysis

The MVP takes a complete screen MP4 and timestamped tracking JSON. It returns `suspected_confusion`, `possible_questions`, and a `summary` for the desktop to display. The structured result also includes a status and clip-relative evidence. A weak clip returns `insufficient_evidence`.

## Run it on Matt’s files

From the repository root, use Python 3.10+ and FFmpeg/FFprobe on `PATH`. The live commands use `GEMINI_API_KEY` from the environment or the Git-ignored `agentic_system/assistant/.env` file. The default is Gemini 3.5 Flash-Lite.

```sh
python3 -m agentic_system.assistant analyze \
  --video "$HOME/Downloads/interval-04-screen.mp4" \
  --tracking "$HOME/Downloads/interval-04-tracking.json"
```

The sidecar’s SHA-256 and video geometry are checked. The clip is unannotated, so the entire interval is considered. When Matt supplies start and end times, pass `--event-start-us` and `--event-end-us` in microseconds relative to the clip. Gemini gets the whole screen video, up to 16 time-aligned gaze samples, and one timestamped still for text detail. Camera frames, playback audio, raw confusion scores, and the meeting transcript stay outside the model request.

## Connect the desktop locally

Start the backend on loopback with a bearer token shared with the test client. Use `--provider scripted` to test the wire format without a Gemini key.

```sh
OJOS_LOCAL_TOKEN=ojos-demo python3 -m agentic_system.assistant serve
```

For a raw screen recording and Matt-style sidecar, call the local prototype endpoint. It returns HTTP 200 and the three fields in JSON when analysis completes.

```sh
curl -fsS 'http://127.0.0.1:8766/v1/analyze' \
  -H 'Authorization: Bearer ojos-demo' \
  -F "video=@$HOME/Downloads/interval-04-screen.mp4;type=video/mp4" \
  -F "tracking=@$HOME/Downloads/interval-04-tracking.json;type=application/json"
```

For desktop capture bundles, submit `manifest`, `gaze`, and `video` to [protocol v1](../../docs/protocol.md) `POST /v1/jobs` and open `GET /v1/jobs/{job_id}/events`. The local prototype emits `job.analysis` with all three fields immediately before `job.result`. The v1 `job.result` still puts the first possible question in `likely_question` and the summary in `answer`. The endpoint also supports SSE resume and cancellation. The prototype does not implement the v1 messages route.

## Verify and compare

```sh
python3 -m unittest discover -s agentic_system/assistant -t . -v
python3 -m agentic_system.assistant inspect \
  --video "$HOME/Downloads/interval-04-screen.mp4" \
  --tracking "$HOME/Downloads/interval-04-tracking.json"
```

`inspect` runs locally and measures media preparation for video, video with gaze, video with gaze and a still, and stills with gaze. For a live comparison, run `analyze` on the same clip with different `--variant` or `--model` values. Score each result on these checks before comparing times.

| Check | Expected on Matt’s clip |
| --- | --- |
| Suspected confusion | Describes the difficulty of turning the desk clues and two drafted pairs into a left-to-right order. Uses tentative wording. |
| Possible questions | Gives distinct questions the person might actually have about the visible puzzle. |
| Helpful summary | Anchors the approach on Omar’s fixed seat and applies the remaining clues without revealing the whole ordering. |
| Grounding | Cites observations visible near the reported times. The clip has one answer box. Its contents establish a draft, not a submission. |

### First live check

Matt’s attached clip was 8.034 seconds with 135 valid gaze points. In one Gemini 3.5 Flash-Lite run with video and gaze, analysis finished in **2.10 s** and understood the puzzle but misstated the draft’s layout. With the added still at **4.017 s**, the CLI run finished in **2.61 s** and generated two grounded questions about using Omar’s fixed seat and ordering Ren and Priya. A separate live request to `/v1/analyze` returned all three fields in **2.81 s** of backend processing. The prototype defaults to the still-assisted variant based on those checks. These are individual replay measurements. A blank-screen control returned `insufficient_evidence` with no suggested questions.

### Intent check with and without gaze

Nine live calls used the same 8.034-second clip, the same decoded still at 3.966102 seconds, and Gemini 3.5 Flash-Lite at low thinking. The `BaselineAnalyzer` calls used the `video-gaze-still` variant with `attach_still_at_us=4000000`. The video and still bytes matched across runs. The three conditions supplied zero gaze samples, 16 samples from Matt’s tracking, or those samples with the vertical coordinates deliberately moved to the browser toolbar.

| Gaze condition | Identified the desk-ordering task | Asked how Omar’s seat determines Mira’s | Median backend time |
| --- | --- | --- | --- |
| No gaze | 3/3 | 2/3 | 2.44 s |
| Matt’s gaze | 3/3 | 2/3 | 2.69 s |
| Deliberately misplaced gaze | 3/3 | 2/3 | 2.73 s |

The screen shows one answer box with `mira omar` and `ren priya` on separate lines. The three recorded-gaze responses quoted those pairs accurately and described the box as multiple boxes in their evidence. One no-gaze response put Mira and Omar on different lines in its confusion statement. Several outputs raised formatting as a possible concern. The task asks for desk order and gives no formatting rule. The likely difficulty is turning the clues and draft pairs into their final order. The actual sticking point remains unlabeled. This clip shows one clear task, so the comparison leaves open whether gaze helps choose between competing on-screen targets. The supplied files contained the screen recording and tracking JSON. A synchronized webcam recording was unavailable for the comparison.

### Reproduce the intent check

```sh
python3 -m agentic_system.assistant.intent_eval \
  --video "$HOME/Downloads/interval-04-screen.mp4" \
  --tracking "$HOME/Downloads/interval-04-tracking.json" \
  --repeats 1
```

`--repeats 1` makes three live Gemini calls. Use `--repeats 3` for the original nine-call design. Each JSON line contains one backend result, its condition, timings, and the SHA-256 hashes of the video, still, prompt, and context with gaze removed. The runner checks that these shared inputs match across conditions. Gemini can give different wording on a rerun.

For manual review, compare each result against the recording. Mark whether it names the desk-ordering task, asks a question about deriving Mira’s seat from Omar’s, and accurately describes the visible clues and draft. The original review was done with the conditions visible. For example, `recorded_gaze`, trial 1, correctly included the Mira question and described multiple answer boxes in its evidence. Score the question and the evidence separately. The participant’s own account would be needed to score whether the inferred sticking point matched their intent.

Local files under `.eval/` include the preserved original nine backend results and a crop of the shared still for review. Git ignores those files.

The `ask`, `compare`, and `eval` commands cover the earlier question-only and task-memory experiment. They do not change the baseline endpoint. See the [follow-up proposal](../../docs/assistant-mvp.proposed.md) for that work.
