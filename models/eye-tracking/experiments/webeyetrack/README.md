# WebEyeTrack experiment

An isolated replay benchmark for replacing the gaze predictor behind Ojos’s existing protocol. The browser worker runs WebEyeTrack’s BlazeGaze weights and upstream preprocessing against the same MediaPipe Face Landmarker results used by Ojos. The native path uses the upstream Keras checkpoint and Python geometry functions. All first-party media and per-frame output stay in the laptop’s local run directory. [Measured benchmark](RESULTS.md)

## Asset and runtime verification

| Asset | Pinned source | SHA-256 |
| --- | --- | --- |
| TF.js LayersModel | docs/public/web/model.json | a214f074ccd4724cf4ebf008814a05485e7eaa5faf5aaeb85e66b24a1af55688 |
| TF.js weights | docs/public/web/group1-shard1of1.bin | c030a762a2d21ac0f3c59700a723b2d8790f2003b3f8e72fbe31129fcb234e58 |
| Native Keras weights | python/webeyetrack/model_weights/blazegaze_mpiifacegaze.keras | 5b011cfe82466896e27b1ac3e18130117cafbc02dbc964a1ad7315f62005cc05 |
| Face Landmarker float16/1 | python/webeyetrack/model_weights/face_landmarker_v2_with_blendshapes.task | 64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff |

The benchmark pins upstream commit 75fbd2f5f784f2eb3a39675a8dcbf1b01c697f1c. The JS shard is 624,072 bytes and the Keras archive is 912,063 bytes. The Face Landmarker bytes match the shipping Ojos asset. Upstream npm 0.0.2 ships dist code and the demo repository supplies the TF.js model separately. The repository publishes the code under MIT and includes both sets of weights. Confirm the intended redistribution terms for the exact checkpoint before a commercial release. The paper describes training on data including MPIIFaceGaze and GazeCapture, whose original terms restrict use. Checkpoint-specific redistribution rights and the training subject list still need confirmation. [Upstream source and license](https://github.com/RedForestAI/WebEyeTrack/tree/75fbd2f5f784f2eb3a39675a8dcbf1b01c697f1c) · [Training paper](https://arxiv.org/html/2508.19544v1) · [MPIIFaceGaze terms](https://doi.org/10.18419/DARUS-3240) · [GazeCapture license](https://github.com/CSAILVision/GazeCapture/blob/master/LICENSE.md)

The JS engine requires a WebCodecs/OffscreenCanvas-capable Chromium host for this benchmark. TF.js WASM and WebGL run in a classic dedicated worker with local assets. The multi-thread WASM benchmark served a cross-origin-isolated loopback origin with COOP same-origin and COEP require-corp. Verify SharedArrayBuffer and the actual thread count when packaging the worker in Electron. The upstream browser wrapper fetches MediaPipe WASM and weights from remote URLs, uses an IMAGE-mode GPU landmark delegate, and can attach its own webcam and click handlers. The experiment serves the pinned Ojos CPU landmark assets locally and uses VIDEO mode with two-face ambiguity rejection and the Ojos confidence settings. The optional GPU case tests a different landmark delegate. The native Keras model runs on CPU and CUDA on supported Linux and WSL2 builds. TensorFlow 2.19.1 on native Windows uses CPU. The Python package wrapper has mutable dataclass defaults that fail on Python 3.12. The harness loads the official geometry code with the minimal field-default fix. Python uses OpenCV for the eye crop and its own landmark-to-head-pose implementation. Web and native scores are therefore reported independently. [Browser wrapper](https://github.com/RedForestAI/WebEyeTrack/blob/75fbd2f5f784f2eb3a39675a8dcbf1b01c697f1c/js/src/FaceLandmarkerClient.ts) · [TensorFlow runtimes](https://www.tensorflow.org/install/pip)

## Run locally on Windows

Use PowerShell from this folder. Point the first-party variables at your recordings and keep the run directory outside the checkout. The staged VP8 payloads are the original compressed webcam packets. The harness decodes them with WebCodecs and sends frames only through localhost to the browser worker. Native inference decodes the same source with PyAV.

~~~powershell
$run = "$env:LOCALAPPDATA/Ojos/webeyetrack-bench"
$upstream = "$env:LOCALAPPDATA/Ojos/webeyetrack-upstream"
$recordings = "$env:USERPROFILE/Videos/Ojos test recordings"
$original = "$recordings/ojos-2026-11-21T16-58-54-523Z-V9MJNF"
$repeat = "$recordings/ojos-2026-11-21T17-26-05-875Z-EbW9Bs"
$analysis = "$env:LOCALAPPDATA/Ojos/session-analysis/2026-11-21-real-run"
git clone https://github.com/RedForestAI/WebEyeTrack.git $upstream
git -C $upstream checkout 75fbd2f5f784f2eb3a39675a8dcbf1b01c697f1c
uv venv --python 3.12 "$run/native-venv"
$python = "$run/native-venv/Scripts/python.exe"
uv pip install --python $python -r requirements.txt
npm ci
node build.mjs $upstream
& $python pack.py $original "$run/original"
& $python pack.py $repeat "$run/repeat"
node --test adapter.test.mjs
node browser.mjs $run accuracy-plan.json "$run/browser-accuracy.json"
node browser.mjs $run layout-plan.json "$run/browser-layout.json"
node browser.mjs $run adapt-plan.json "$run/browser-adapt.json"
node score.mjs $run
& ./run-paced.ps1 -Run $run -AnalysisAssets $analysis -OriginalRecording $original
& ./run-paced.ps1 -Run $run -AnalysisAssets $analysis -OriginalRecording $original -ConfirmLoad
~~~

To run Windows native variants, use the same staged indexes and the original recording directories.

~~~powershell
foreach ($height in @(720, 480)) {
  & $python native.py --upstream $upstream --index "$run/original/index.json" --recording $original --height $height --output "$run/native-original-$height.jsonl"
  & $python native.py --upstream $upstream --index "$run/repeat/index.json" --recording $repeat --height $height --output "$run/native-repeat-$height.jsonl"
}
& $python native.py --upstream $upstream --index "$run/original/index.json" --recording $original --window reasoning --rate 20 --output "$run/native-reasoning-720.jsonl"
node score.mjs $run
~~~

The load pass uses the existing 8 Hz CPU ONNX confusion runtime and its actual YuNet and GRU assets from the earlier analysis. It feeds them a loop of recorded face frames. A second browser workload encodes a synthetic, changing 1920 × 1200 screen at a target 20 Hz. These loads approximate screen recording and confusion inference while preserving the user’s original screen recording. The standalone performance plans use the first 12 seconds of reasoning. The two browser modes differ in whether an RGB canvas readback is needed. Native-resolution MediaPipe uses the transferable VideoFrame directly. WebEyeTrack reads pixels for the eye crop.

## Scoring

Both calibrations use the recorded 250 ms settle and 500 ms collection windows from capture.json and the webcam recorder’s start clock. Each of nine fit targets contributes one median feature vector. Five distinct targets produce the held-out median, p80, and full-viewport pass gate. The validation gate requires all five predictions in bounds and median error at most 8% of the diagonal. Report includes the paired-quality sample checks and ±100 ms alignment sensitivity. The 30 Hz replay supplies shared frames for calibration sensitivity at 20, 15, and 10 Hz. Those are cadence subsamples of one tracker pass. The paced tests run each simulated source schedule directly.

The Ojos model fits its existing seven iris and head-pose inputs. The matched WebEyeTrack ridge fits its two raw gaze outputs with the same ridge objective and nine targets. Its affine fit uses the upstream least-squares procedure on the same nine representatives. The one-step variant uses a real open-eye frame nearest each target-window midpoint and the upstream affine and gradient update. The experiment disables upstream Kalman filtering and clamping before accuracy scoring. It applies Ojos’s invalid projection convention, causal median, and strict 5 Hz resampler for export. The original reasoning replay is scored with independent original and repeat fits. Failed fits can be inspected as counterfactuals. In production, the same failure would leave gaze unavailable.

The browser’s standard rows preserve the upstream matrix interpretation. The optional layout sensitivity transposes the column-major MediaPipe container before upstream WebEyeTrack reads it as row-major. Score each layout with its own calibrated profile. Browser and native EAR implementations also differ. Error, feature usability, out-of-bounds rate, abstention duration, and export availability are measured separately. Reasoning footage has no continuous target labels, so it measures tracking availability and pose shift.

## Public data and offload

Use the existing MPIIFaceGaze Data.zip and prior Ojos observations. The public run uses p13 and p14, the first three days for calibration and one in three later stills. Later scoring pairs the exact images and reuses the original Ojos Face Landmarker observations. Use the public results as a reproducible compatibility comparison. Membership of these two subjects in the released BlazeGaze checkpoint’s training set is unknown.

~~~sh
# Linux native environment, after installing the same pinned requirements.
# For CUDA install tensorflow[and-cuda]==2.19.1 and make its NVIDIA shared libs discoverable.
CUDA_VISIBLE_DEVICES=-1 OJOS_TF_DEVICE=/CPU:0 python native.py --upstream "$upstream" --archive "$archive" --people p13 p14 --stride 3 --output "$out/cpu"
OJOS_TF_DEVICE=/GPU:0 python native.py --upstream "$upstream" --archive "$archive" --people p13 p14 --stride 3 --output "$out/gpu"
node public-score.mjs "$original_observations" "$out/cpu" "$out/public-cpu.json"
node public-score.mjs "$original_observations" "$out/gpu" "$out/public-gpu.json"
~~~

For the Vast deployment probe, run roundtrip.py server UPSTREAM on the remote, holding the shared GPU lock. The client uses a persistent SSH connection, pre-encoded public JPEGs and a 20 Hz latest-frame queue. The reported network residual includes request upload, framing, response transport, and SSH overhead. It subtracts measured server JPEG decode and inference. Camera readout and client image encode happen outside this probe. Server startup includes session setup and GPU-lock waiting if present. The per-frame server service runs serially so there is no separate multi-client server queue.

## Swap boundary

A replacement can keep the desktop caller and clip exporter. It needs a local worker that consumes the existing frame/time and epoch contract, packages the pinned model and TensorFlow assets, sets a new model-specific calibration and device key, and uses held-out error for uncertainty. Map BlazeGaze’s center-relative output to normalized display coordinates by adding 0.5, then use Ojos’s existing orientation and encoded viewport mapping. Gate on eye and face state before interpreting upstream coordinates. Its closed-eye fallback uses a center-relative (0, 0) placeholder. Emit null coordinates and uncertainty for eye/face loss, calibration failure, and off-screen projection. Publish internal dropout reasons and cadence from the worker, and keep calibration and landmarks local. The adapter test verifies schema, rotation, invalid events and the unchanged 5 Hz export call. A shipping integration still needs a real camera and recorder trial and independent fixation labels after motion.
