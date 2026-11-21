# WebEyeTrack swap benchmark

WebEyeTrack is the stronger candidate for staying in bounds after a posture change. The existing MediaPipe ridge produced the best immediate calibration on the repeat session. Keep the shipped gaze path in place while testing WebEyeTrack as a local worker option and collecting labeled fixation checks after motion.

## First-party held-out targets

The table uses the same recorded frames, nine fit positions, five held-out positions, and normalized-to-encoded mapping for both pipelines. Entries are median / p80 radial error in 1920 × 1200 screen pixels. The startup gate also requires all five predictions in bounds and median at most 181 px. Only the MP original cases shown here failed among the matched ridge variants.

| Runtime and calibration | Original | Repeat |
| --- | ---: | ---: |
| Chromium MediaPipe ridge, 720p/20 | 382 / 456 | **64 / 106** |
| Chromium WebEyeTrack ridge, 720p/20 | **149 / 204** | 111 / 147 |
| Chromium WebEyeTrack affine, 720p/20 | 167 / 229 | 138 / 149 |
| Chromium MediaPipe ridge, 480p/20 | 262 / 415 | 68 / 127 |
| Chromium WebEyeTrack ridge, 480p/20 | 158 / 182 | 149 / 157 |
| Windows native MediaPipe ridge, 720p/20 | 376 / 538 | 108 / 126 |
| Windows native WebEyeTrack ridge, 720p/20 | 137 / 184 | 114 / 165 |

720p is the native camera resolution, 1280 × 720. The lower setting is 853 × 480. The 20 Hz calibration rows replay the 30 Hz observation set with a cadence subsample. The previous analysis used a per-source-frame native pass and reported 358 px for the first session and 72 px for the repeat. The browser and native replays also differ in video conversion and interpolation, and use timestamps from the webcam recorder start. At 30 Hz on the exact jointly usable browser frames, the original scored 312 px MediaPipe and 135 px WebEyeTrack ridge. The repeat scored 43 px and 98 px. With ±100 ms alignment perturbations at 30 Hz, the original MediaPipe median ranged from 244 to 384 px and WebEyeTrack ridge from 82 to 168 px. These are single-person results.

With the repeat coefficients applied to the original labeled validation positions at 720p/20, the median error was 417 px MediaPipe and 99 px WebEyeTrack ridge. In the other direction it was 897 px and 196 px. The original MediaPipe fit failed its startup gate, so that transfer is diagnostic. The stock browser affine-plus-one-gradient update took about 485 ms per session. It scored 196 px on the original and 171 px on the repeat, with only the repeat passing. A separate matrix-layout sensitivity reached 171 px on the original and 83 px on the repeat with matched ridge. The stock layout and fixed ridge were used for the full replay and latency comparison.

## Reasoning replay and drift

The 519-second original reasoning segment has no continuous gaze labels. Use in-bounds coverage and abstention to describe availability. The five-target test and the cross-session transfer above describe measured error.

| Chromium 720p/20 fit | In-bounds frames | Valid 5 Hz slots | p95 invalid run | Longest invalid run |
| --- | ---: | ---: | ---: | ---: |
| MediaPipe, original fit | 2.4% | 46 / 2,596 | 36.2 s | 84.2 s |
| WebEyeTrack ridge, original fit | 78.1% | 1,941 / 2,596 | 1.20 s | 2.85 s |
| MediaPipe, repeat fit | 12.2% | 284 / 2,596 | 18.4 s | 71.2 s |
| WebEyeTrack ridge, repeat fit | **83.0%** | **2,074 / 2,596** | **0.86 s** | **1.68 s** |

The failed original MP fit is shown as a counterfactual. The shipped gate would export unavailable for it. The same replay processed 10,382 observations at 20 Hz. Both had a face in every observation. MediaPipe’s eye gate rejected 596 frames (5.7%) and WebEyeTrack’s browser EAR rejected 1,000 (9.6%). Most remaining MediaPipe losses were out-of-bounds projections. Median roll shifted from +1.81° during the repeat calibration to −7.85° during reasoning. Native WebEyeTrack’s different EAR rule rejected 5,010 frames (48.3%) and achieved 51.5% coverage with the repeat fit. Its longest invalid run was 9.18 s. That is a material disadvantage for the native path.

Subsampling the 720p reasoning pass to 15 Hz gave WebEyeTrack 1,969 valid grid slots. The 10 Hz subsample gave 1,656. The existing resampler interpolates across gaps strictly below 100 ms, so a 10 Hz nominal cadence offers little room for jitter or a skipped sample.

The 480p reasoning sample covers only the first 60 seconds. Its repeat-fit in-bounds coverage was 31.0% for MediaPipe and 93.8% for WebEyeTrack ridge, with 88 and 279 of 300 valid grid points. These values apply to the easier first minute of the recording. The 480p repeat calibration also raised the WebEyeTrack median error from 111 to 149 px at 20 Hz.

## Public native check and offload

The MPIIFaceGaze comparison reused the prior Ojos landmarks on exactly matched p13 and p14 stills. After calibration from the first three days, 626 later images were usable by both pipelines. Median radial error as a fraction of the display diagonal was 16.0% MediaPipe, 10.8% WebEyeTrack ridge, and 11.6% WebEyeTrack affine. In-bounds predictions were 446, 467 and 429 of 626 in the CPU run. The CUDA figures closely matched the CPU figures. This is a two-person comparison. Membership of those subjects in BlazeGaze’s pretraining data is unknown. [Ojos public baseline and methodology](../../offline/results.md) · [WebEyeTrack experiment paper](https://arxiv.org/html/2508.19544v1)

On the Vast A100, native CUDA cut network inference from about 19–20 ms median to 4.1 ms, while geometry and eye preparation remained about 42 ms and CPU Face Landmarker took about 18 ms. In the separate 15-second end-to-end probe with 20 Hz offered over one persistent SSH connection, public JPEGs were about 28 KB median. The client retained at most one pending frame. The warm delay includes the upload and reply, server decode and inference, and the measured client queue.

| Vast route | Delivered | Dropped / offered | Capture age p50 / p95 | Client queue p50 / p95 | Network residual p50 / p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Native CPU | 4.15 Hz | 236 / 300 | 236 / 436 ms | 21 / 49 ms | 123 / 283 ms |
| Native CUDA | 4.27 Hz | 235 / 300 | 220 / 383 ms | 32 / 48 ms | 121 / 271 ms |

The measured route fell below the 5 Hz export target even with small pre-encoded public JPEGs. Camera acquisition and image encoding would add work. The shared GPU lock also delayed the public batch by 197 seconds. Keep first-party gaze inference on the laptop.

## Laptop scheduling and latency

The 12-second paced pass uses the same first reasoning frames in Chrome 157 on an Intel Core i7-13700H laptop. Native webcam cadence supplied 343 frames to the nominal 30 Hz pass. The load run adds CPU YuNet/ONNX GRU and a synthetic 1920 × 1200 VP8 screen stream. The GRU session reported 1,466 usable updates at 8 Hz with zero skipped ticks. Typical screen cases encoded 239–240 frames in 12 seconds. Capture-age statistics exclude the first second. The age clock starts at simulated capture time and includes replay deadline slip, the one-frame queue, processing and the returned sample. Live camera sensor and desktop capture delays are outside this measurement.

| Local Chromium setting | Delivered Hz | Dropped / offered | Age p50 / p95 | Valid 5 Hz slots |
| --- | ---: | ---: | ---: | ---: |
| MediaPipe 720p/20, loaded | 20.0 | 0 / 240 | 22 / 36 ms | 2 / 60 |
| WebEyeTrack 720p/30, idle WASM 1 thread | 22.0 | 78 / 343 | 63 / 84 ms | 54 / 60 |
| WebEyeTrack 720p/20, idle WASM 2 threads | 19.8 | 2 / 240 | 41 / 56 ms | 54 / 60 |
| WebEyeTrack 720p/20, loaded WASM 2 threads | 19.6 | 4 / 240 | 54 / 76 ms | 54 / 60 |
| WebEyeTrack 720p/15, loaded WASM 1 thread | 14.9 | 1 / 180 | 45 / 61 ms | 53 / 60 |
| WebEyeTrack 720p/10, loaded WASM 1 thread | 10.0 | 0 / 120 | 48 / 63 ms | 41 / 60 |
| WebEyeTrack 480p/20, loaded WASM 2 threads | 19.7 | 3 / 240 | 60 / 85 ms | 53 / 60 |
| WebEyeTrack 720p/20, idle WebGL CNN | 17.8 | 44 / 400 | 50 / 74 ms | 81 / 100 |
| WebEyeTrack 720p/20, idle WebGL CNN + GPU landmarks | 7.5 | 249 / 400 | 136 / 174 ms | 29 / 100 |

The separate 24-second loaded check confirmed 720p/20 WASM with two threads at 19.90 Hz, 2 drops out of 480, 45 / 62 ms age and 111 / 120 valid export slots. At 480p with two threads it delivered 19.85 Hz, 51.8 / 78.9 ms age and 110 / 120 valid slots. A short 480p single-thread test dropped 192 of 240 frames while multiple stages slowed. The 24-second rerun recovered to 19.47 Hz with 12 drops and 89 ms p95. The repeat’s 720p setting had a lower p95 capture age and one more valid slot. The confirmation load delivered all 609 expected 8 Hz confusion updates.

The WebGL cases reported ANGLE on Intel Iris Xe. The first 720p result took 2.26 s with CPU landmarks and 4.37 s with GPU landmarks, including shader warm-up. The experimental browser assets total 27.9 MB. Native Windows replay at 720p measured RGB preparation at 0.8 / 1.2 ms, landmarks at 11.9 / 14.7 ms, open-eye geometry/crop at 26.2 / 32.1 ms and Keras inference at 15.3 / 20.6 ms (p50 / p95). It processed the 10,382 sampled frames in 378 seconds of unpaced replay, with model calls skipped on closed-eye frames. The optional laptop WSL CUDA install had yet to finish when it was stopped to free the laptop for the next experiment. Native CUDA timings in this report are from Vast, and the laptop GPU results are from Chromium’s WebGL backend.

For loaded 720p/20 WASM with two threads, stage p50 / p95 was 2.7 / 3.6 ms for full-frame preparation, 22.3 / 26.9 ms for landmarks, 7.6 / 12.1 ms for the eye crop and metric pose, 11.0 / 14.5 ms for BlazeGaze and result readback, ≤0.1 ms for postprocessing, and 1.9 / 27.1 ms for waiting in the latest-frame queue. Use the measured capture-age percentiles for the end-to-end distribution.

Use 720p/20 with two WASM threads when trying WebEyeTrack locally. At 20 Hz, a change can wait up to a nominal 50 ms for the next scheduled frame. Under a uniform arrival assumption, the p95 of that cadence wait is 47.5 ms. Use about 124 ms as an estimated loaded reaction budget by combining it with the measured 76 ms p95 age. The same estimate is about 84 ms for the loaded MediaPipe path with its measured 36 ms p95. These sums estimate a reaction budget from separate timing distributions. The three-sample median can add one more sample period for a sustained gaze change. At 15 Hz, the corresponding nominal cadence and measured 61 ms age also give roughly 124 ms, with fewer valid slots and more exposure to the 100 ms interpolation limit. Use 15 Hz as a fallback if the 20 Hz queue grows. The 10 Hz setting sacrificed export coverage even with no drops. 30 Hz added queue pressure with no improvement in the 12-second export. Downsample only after demonstrating a stability gain on the deployment laptop. The lower resolution left the fixed eye crop and network work in place and performed worse on the repeat calibration at 20 Hz.

The existing exporter still emits the exact 5 Hz grid with invalid entries where required. The matched-ridge reasoning replay produced 2,074 valid slots out of 2,596. The raw model landed in bounds more often, at 90.4%, but its repeat held-out error and bias are separate measurements. Use the fraction of valid grid slots and the longest invalid run alongside the nominal export cadence.
