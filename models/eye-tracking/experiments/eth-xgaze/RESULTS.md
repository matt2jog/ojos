# ETH-XGaze benchmark results

ETH-XGaze’s camera-plane estimator approaches WebEyeTrack’s error on the two-person public comparison. WebEyeTrack performed better on the first local calibration. ETH-XGaze’s Windows CPU processing also exceeded the 50 ms per-frame budget for the existing 20 Hz target. The official artifact is useful for this research comparison. Keep the existing default while evaluating a deployable worker and confirming checkpoint rights.

## Vast A100 and MPIIFaceGaze

The same 1,748 original p13/p14 images were replayed as the WebEyeTrack experiment. A total of 1,747 had usable ETH-XGaze estimates and the remaining image lost face tracking. On the 626 later-day images that all three pipelines could score, the 9-target ridge gave the following results. Coverage reports predicted positions in bounds, including any samples that the validation gate would flag before deployment. The entries reflect two participants and a shared public sampling design. [MPIIFaceGaze dataset](https://doi.org/10.18419/DARUS-3240)

| Predictor | Median diagonal error | In bounds | Initial gates |
| --- | ---: | ---: | ---: |
| Ojos MediaPipe ridge | 16.0% | 446 / 626 | 2 / 2 |
| WebEyeTrack ridge | 10.8% | 467 / 626 | 2 / 2 |
| ETH-XGaze camera plane ridge | 11.5% | 453 / 626 | 2 / 2 |
| ETH-XGaze direction-only ridge | 20.6% | 409 / 626 | 2 / 2 |

The camera-plane variant scored 295/126 px median on p13/p14, versus 191/142 px for WebEyeTrack ridge and 284/216 px for MediaPipe ridge. The direction-only variant was more vulnerable to head translation. The public result uses published camera intrinsics and lens correction. [Ojos public benchmark](../../offline/results.md)

The A100 run took 73.1 seconds, equivalent to 23.9 images/sec unpaced including JPEG decoding. Batch-one service for usable images measured 37.9 / 43.4 ms median / p95. CPU Face Landmarker took 17.5 / 22.8 ms, normalization and tensor preparation 13.1 / 14.1 ms, and CUDA ResNet with synchronous host transfers 6.9 / 7.5 ms. The service clock starts after the image decoder. The same Vast run on CPU took 252.1 seconds (6.93 images/sec), with usable service at 132.0 / 202.5 ms median / p95 and ResNet at 101.4 / 162.5 ms. Its paired plane error was 11.49% versus 11.48% on CUDA. The measured Vast path should stay a public benchmark. The laptop inference application requires local video.

### Public upload probe

The same public JPEGs and bounded SSH queue as the WebEyeTrack experiment supplied 300 frames over 15 seconds at 20 Hz. ETH-XGaze returned 102 replies (6.72 Hz) and dropped 198 frames. The median payload was 28.4 KB. Server service was 31.5 / 37.6 ms median / p95. Capture-to-reply age was 165.9 / 206.2 ms, including client queue delay of 23.8 / 45.1 ms. The network residual was 107.3 / 130.5 ms. The 6.72 Hz result measures uncalibrated replies. An export that requires adjacent valid source timestamps less than 100 ms apart cannot infer 5 Hz validity from that rate alone.

## Local labeled calibration

Both Windows recordings used the same 20 Hz timestamp scheduler, nine fit windows and five held-out windows. Entries give median / p80 radial error in 1920 × 1200 screen pixels. A pass requires all five predicted targets in bounds and median error at most 181 px. The local webcam used an estimated 60° horizontal field of view.

| Predictor | Original | Repeat |
| --- | ---: | ---: |
| Matched MediaPipe native 720p | 372 / 535, fail | 108 / 126, pass |
| ETH-XGaze plane native 720p | 277 / 370, fail | 108 / 142, pass |
| ETH-XGaze slopes native 720p | 274 / 360, fail | 109 / 145, pass |
| Matched MediaPipe native 480p | 251 / 410, fail | 106 / 148, pass |
| ETH-XGaze plane native 480p | 274 / 285, fail | 82 / 128, pass |
| ETH-XGaze slopes native 480p | 268 / 291, fail | 85 / 129, pass |
| WebEyeTrack ridge Chromium 720p | 149 / 204, pass | 111 / 147, pass |

Applying the 720p repeat fit to the original labeled validation produced median error of 106 px for the ETH-XGaze camera plane, 180 px for its direction-only variant and 383 px for the matched MediaPipe ridge. Reverse transfer gave 126, 65 and 1,316 px respectively. The reverse values are diagnostic because the original fits failed their gate. This illustrates sensitivity to calibration transfer for one user.

On native Windows CPU with two Torch threads, the 720p calibration runs measured 67.9–69.6 ms median and 80.6–82.8 ms p95 for usable frame service. The CNN alone measured 55.7–57.0 ms median and 66.1–68.5 ms p95. The 480p camera input still feeds a 224 × 224 network crop and measured 85.3–97.8 ms p95 in these passes. Neither native CPU resolution met a continuous 20 Hz latency budget on this setup.

## Reasoning replay

The complete 519.1-second reasoning window produced 10,382 sampled observations. The unpaced Windows CPU pass took 730.8 seconds including decoding, equivalent to 14.21 observations/sec or 0.71× real-time playback. Usable observations took 68.4 / 79.7 ms median / p95 for in-process service and 55.9 / 65.9 ms for the ResNet. The ETH-XGaze quality gate discarded 606 blinks and face detection remained stable throughout. The recording supplies no continuous fixation labels, so the table measures availability and dropout.

| 720p profile applied | Startup gate | In-bounds samples | Valid 5 Hz slots | Invalid run p95 | Longest invalid run |
| --- | --- | ---: | ---: | ---: | ---: |
| MediaPipe, original | fail | 196 / 10,382 (1.9%) | 34 / 2,596 | 41.82 s | 92.38 s |
| ETH-XGaze slopes, original | fail | 8,740 / 10,382 (84.2%) | 2,115 / 2,596 | 0.74 s | 6.61 s |
| ETH-XGaze plane, original | fail | 8,220 / 10,382 (79.2%) | 1,978 / 2,596 | 1.04 s | 6.61 s |
| MediaPipe, repeat | pass | 1,275 / 10,382 (12.3%) | 295 / 2,596 | 25.30 s | 82.99 s |
| ETH-XGaze slopes, repeat | pass | 8,942 / 10,382 (86.1%) | 2,173 / 2,596 | 0.90 s | 3.27 s |
| ETH-XGaze plane, repeat | pass | 8,673 / 10,382 (83.5%) | 2,091 / 2,596 | 0.72 s | 3.68 s |

Rows whose original fit failed are counterfactual. Ojos would leave gaze unavailable with that calibration. The comparison uses an offline 20 Hz camera timestamp schedule, so the valid-grid counts do not include extra misses from a live CPU backpressure queue. The preceding Chromium WebEyeTrack replay on the same reasoning interval with its repeat fit produced 83.0% in bounds and 2,074 / 2,596 valid 5 Hz slots.

## Verification and locations

The PyTorch port matched the checkpoint-loaded official forward pass with 0 radians maximum absolute error on two seeded synthetic crops. Both ETH geometry tests and all six existing Ojos gaze tests passed, including calibration, timing, invalid intervals, and the 5 Hz export. [Reproduction commands and asset terms](README.md)

- Vast public run at /workspace/ojos-runs/eye-tracking/eth-xgaze
- Laptop run at C:/Users/matth/AppData/Local/Ojos/eth-xgaze-bench
