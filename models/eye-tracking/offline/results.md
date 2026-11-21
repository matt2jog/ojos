# Vast gaze baseline

Run mpiifacegaze-v1 processed 37,667 labeled stills from 15 MPIIFaceGaze participants. The evaluator excluded seven frames at a different camera resolution and 243 out-of-screen target labels. The quality gate accepted features for 37,238 of 37,417 eligible images (99.5%). Nine target bins supported 14 personal ridge fits. Four of 15 participants passed the five-target startup gate in the still-image proxy. MediaPipe weights stayed frozen throughout the experiment. [Dataset and terms](https://doi.org/10.18419/DARUS-3240)

| Paired later-day benchmark | Median radial error | Median diagonal error | p80 radial error | In-bounds coverage |
| --- | ---: | ---: | ---: | ---: |
| Personal ridge | 309 px | 18.8% | 533 px | 66.3% |
| Leave-one-person-out ridge | 231 px | 14.1% | 365 px | 88.3% |
| Screen center | 438 px | 26.6% | 614 px | 99.8% |

The table pairs 28,636 feature-usable frames from the 28,696 eligible later-day frames belonging to the 14 fitted participants. Unclamped error includes out-of-bounds predictions. Coverage uses all 28,696 eligible frames. The four participants who passed the initial gate had a 17.3% median of participant later-day median diagonal errors. Only 1,253 of their 4,304 valid later-day predictions (29.1%) fell within their original p80 radii. These measurements show the need to check for drift when reusing calibration.

The published data uses cropped face regions with masked backgrounds, irregularly sampled stills, and target labels from natural laptop use. The proxy bins approximate the fourteen display positions and span multiple days. Live calibration uses consecutive observations in one session. The person-disjoint model is a benchmark and the handoff uses the approved per-device fit. The next validation needs first-party screen targets, webcam frames, and known timestamps.

## Performance and protocol checks

- Vast AMD EPYC 7662, Python 3.12.15, and MediaPipe 0.10.21 CPU TFLite. Three extraction processes achieved 113.7 images/sec aggregate, including JPEG decoding, checksum verification, and writing observations. Time inside detection and converting its result averaged 20.0 ms per image. The run took 331 seconds.
- Chromium Headless Shell 141.0.7390.37, CPU WASM with SwiftShader for WebGL, and a 1280 × 720 still from the same dataset. The 121-frame trace used simulated 30 Hz timestamps and produced 81 inferred samples at 20 Hz on that timeline. After warmup, median worker request-to-response time was 35.9 ms and p95 was 41.3 ms during dataset extraction. The final packaged worker measured 32.7 ms median and 34.0 ms p95 after extraction ended. The initial real image matched Python’s seven features within 1.62 × 10⁻⁵ absolute error. The replay replaced six input frames with blank frames and confirmed invalid gaze in the exported clip and recovery afterward. It used fixture coefficients and sequential worker calls. Its timing excludes live acquisition, screen recording, and confusion inference.
- Six automated checks cover target timing, calibration gating and persistence, an independent ridge solution, feature quality, median filtering, 5 Hz export, and frame backpressure. A standalone [gaze replay trace](../test/gaze-replay.json) covers clip-relative timestamps, explicit invalid gaps, an exact 100 ms gap, and epoch isolation.

## Run files and laptop acceptance

On Vast, the run directory is /workspace/ojos-runs/eye-tracking/mpiifacegaze-v1. Review extract.log, evaluate.log, browser.log, browser-final.log, report.json, browser.json, browser-final.json and observations/extraction.json. Research coefficients are in research-fits.json under the same directory. The dataset is kept separately at /workspace/ojos-data/eye-tracking/Data.zip. [Per-participant report](results.json)

On each target laptop, display the nine fit and five validation positions with the single webcam stream and screen recording active. Compare the five-target median and p80 error with a second held-out pass after recording and after normal posture changes. Measure effective Hz, usable-prediction coverage, dropped frames and the latency distribution while the confusion model is running. Check blinks, camera loss, reconnects, glasses, typical lighting, viewport edges and display or resolution changes. Record the actual camera and encoded geometry for each run. Keep gaze disabled when calibration fails and check that video and audio analysis continue.
