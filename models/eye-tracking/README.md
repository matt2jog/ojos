# Ojos gaze tracking

The gaze worker uses the pinned MediaPipe Face Landmarker and a per-camera/display ridge calibration. It receives unmirrored frames from the desktop’s existing webcam track. Calibration fits two linear outputs with seven features from the two irises and the face rotation matrix. Inference runs on the laptop with CPU TFLite and local WASM assets.

## Build and handoff

Use Node.js 22 or newer from this directory.

~~~sh
npm ci
npm test
npm run build
~~~

The build verifies and stages Face Landmarker float16/1, packages the classic worker, and copies the WASM and license files into dist. The dist/host directory has the browser-compatible helpers for target collection, calibration persistence, frame backpressure, and clip export. Set OJOS_FACE_MODEL to the path of a cached model for a network-independent build after npm ci. Serve or package the whole dist directory from the desktop app’s trusted local origin. Use absolute app-served URLs for modelUrl and wasmRoot, and serve .wasm files as application/wasm. Runtime inference makes no external requests. The pinned npm package and the model bundle declare Apache 2.0. The build includes their license and attribution. [Runtime](https://www.npmjs.com/package/@mediapipe/tasks-vision/v/0.10.21) · [Model card](https://huggingface.co/litert-community/MediaPipe-FaceLandmarker)

Integrate createGazePipeline from src/vision.mjs into the existing vision worker, or host dist/gaze-worker.js as a classic worker with the preview and calibration UI on the desktop side. Both use the same feature extraction, coefficients, quality gates and causal filter.

| Worker request | Fields besides type and requestId | Response |
| --- | --- | --- |
| start | options with sessionId, captureEpoch, geometry, calibration or null, and assets with wasmRoot and modelUrl | ready |
| frame | transferable VideoFrame or ImageBitmap, timeUs | frame.done with output or null when cadence skips |
| tracking.lost | timeUs | tracking.lost.done with invalid output |
| calibration | calibration object or null | calibration.done |
| stats | | stats.done |
| close | | closed |

The worker echoes requestId. Wait for ready before sending frames. Drain the previous epoch, discard its late replies by session and epoch, and start a fresh graph and ring at every capture epoch change. Retain ownership of your original webcam frame for any other consumer by passing the worker a clone. The worker closes the transferred frame. For a separate worker, LatestGazeFrames in src/frame-queue.mjs bounds the sender to an in-flight request and the latest waiting frame. The send callback takes ownership and must settle on frame.done or error. Send explicit tracking loss once queued frames are drained, or discard pending frames before signaling the loss. For an integrated pipeline, call processFrame and trackingLost directly and have the caller close its frames.

Use capture timestamps mapped to session microseconds. The cadence samples distinct frame times against 50 ms deadlines and skips intervening frames. Report effectiveHz, inference latency and cadenceSkipped from stats. Report droppedFrames separately from the queue or upstream camera source. A two-face limit allows abstention on ambiguous frames and disables MediaPipe’s single-face smoothing. The causal three-sample median resets at invalid observations and gaps of 100 ms or more. The local output includes an observation and diagnostic reason. Forward only output.message to the desktop ring.

## Calibration and clip export

Pass geometry with cameraId, cameraWidth, cameraHeight, displayId, displayScale, rotationDeg, viewportWidth and viewportHeight. rotationDeg is the clockwise transform still needed from the calibration target coordinates to the encoded viewport. Supply 0 when the desktop already describes targets in encoded orientation. Normalized endpoints map to the corresponding first and last pixel centers. Camera dimensions describe the exact frames passed to MediaPipe.

1. Load a matching calibration with loadCalibration(storage, geometry) from src/calibration.mjs. The storage adapter supplies getItem, setItem and removeItem. Keep it on the laptop. During explicit recalibration for drift, clear the old calibration and set the active calibration to null.
2. Create a CalibrationSession for the current geometry. Render nextTarget.point on the selected display and call showTarget with the session timestamp when the target appears. Its capture window starts after 250 ms and lasts 500 ms. Feed each worker output.observation and its session time to observe. Once outstanding frames through the window are processed, call finishTarget. Repeat for nine fit targets and five distinct validation targets. Each target contributes a median feature vector and one target label.
3. Call fit. The five held-out residuals determine median pixel error and the p80 uncertainty radius. The gate requires five usable predictions and median error at or below 8% of the encoded diagonal. On success, call saveCalibration and pass the calibration to the worker. On failure, keep gaze unavailable and continue video and audio analysis. Re-run calibration for changes in camera, resolution, display, scale, encoded geometry or orientation, and when the preview drifts.
4. Call exportGaze from src/timeline.mjs with the chronological worker history, sessionId, captureEpoch and actual retained clip bounds clipStartUs and clipEndUs. It returns gaze_status and the schema-versioned gaze part. It samples the half-open clip at 200,000 µs intervals. Interpolation uses adjacent valid points strictly less than 100 ms apart. Intervening invalid records block it. Keep neighboring history around the actual clip start and end when available. Use a fresh ring if the epoch changes. [Shared protocol](../../docs/protocol.md)

The quality checks use MediaPipe detection, face presence and tracking thresholds of 0.60, a seven-pixel minimum eye width, landmark-based blink detection, and caps of 35° yaw and 30° pitch and roll. Iris offsets are expressed in each eye’s coordinate frame. Predictions outside the encoded viewport are marked invalid. The startup gate and error radius use only five short samples, so track their relationship to later error during live use.

## Reproduce the public-data baseline

Use the MPIIFaceGaze archive only for noncommercial scientific evaluation. Cite Bulling (2023), DaRUS DOI 10.18419/DARUS-3240, and the linked MPIIGaze and full-face gaze papers. DaRUS provides labeled laptop screen-pixel targets and monitor sizes. Its images mask the background and are isolated stills. GazeCapture requires an activated MIT account, uses phones and tablets, and has its own usage terms. EYEDIAP has time-aligned screen-target video and requires access approval. This run used the public DaRUS files. [MPIIFaceGaze dataset and terms](https://doi.org/10.18419/DARUS-3240) · [Full-face gaze paper](https://arxiv.org/abs/1611.08860) · [MPIIGaze paper](https://arxiv.org/abs/1711.09017) · [GazeCapture access](https://gazecapture.csail.mit.edu/download.php) · [EYEDIAP access](https://zenodo.org/records/4467455)

On the VPS, prepare an isolated Python 3.12 environment and keep the dataset and run outputs outside the checkout. Run sustained extraction under supervisor. The extraction runs CPU inference with three workers by default.

~~~sh
data=/workspace/ojos-data/eye-tracking
run=/workspace/ojos-runs/eye-tracking/mpiifacegaze-v1
mkdir -p "$data" "$run"
/venv/main/bin/python -m venv --system-site-packages "$data/.venv"
uv pip install --python "$data/.venv/bin/python" -r offline/requirements.txt
curl -fLSs https://darus.uni-stuttgart.de/api/access/datafile/198951 -o "$data/Data.zip"
curl -fLSs https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task -o "$data/face_landmarker.task"
"$data/.venv/bin/python" offline/extract.py --data "$data/Data.zip" --model "$data/face_landmarker.task" --output "$run/observations" --workers 3
npm run evaluate -- "$run/observations" "$run"
~~~

The evaluator keeps each participant’s dominant input resolution and published screen dimensions. It excludes out-of-bounds target labels. It bins usable observations from the first three capture days into the nearest of the fourteen fixed anchors, with a 10%-diagonal distance limit. Up to five stills per anchor contribute median features and median actual screen labels. The nine fit bins and five validation bins are disjoint. All remaining capture days form a later-day holdout. A leave-one-person-out ridge benchmark uses only other people’s fit rows and the screen-center baseline uses the same held-out images. Error statistics include unclamped predictions. Coverage counts only in-bounds predictions over eligible labeled images. These stills approximate target positions without the live timing or continuous motion of the laptop calibration. Keep the research fits and observations out of the laptop distribution.

To reproduce WASM parity, use the same real image in both runtimes. The smoke uses fixture coefficients to verify projection and exports a trace with deliberate face loss and recovery.

~~~sh
OJOS_FACE_MODEL="$data/face_landmarker.task" npm run build
npx playwright install --only-shell chromium
unzip -p "$data/Data.zip" Data/p00/day01/0005.jpg > "$run/browser-input.jpg"
head -n 1 "$run/observations/p00.jsonl" > "$run/browser-input.json"
npm run verify:browser -- "$run/browser-input.jpg" "$run/browser-input.json" "$run/browser.json"
~~~

See [experiment results](offline/results.md) for the measured baseline and laptop checks.
