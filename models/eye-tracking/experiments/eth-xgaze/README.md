# ETH-XGaze benchmark

This worktree evaluates the author’s official ResNet-50 checkpoint for Ojos screen coordinates. The model produces normalized pitch and yaw from a 224 × 224 RGB face patch. The experiment uses the pinned Ojos Face Landmarker and its two-face gate, estimates pose using six MediaPipe eye and nose landmarks with OpenCV solvePnP, and uses the official face normalization constants (960 focal length and 600 mm camera distance). It rotates the gaze ray back to the physical camera coordinate system before fitting the Ojos ridge. The primary variant intersects it with a proxy plane through the camera. A second variant uses ray slopes to test the effect of accounting for face translation. The webcam benchmark estimates intrinsics from a 60° horizontal field of view. The public benchmark uses the published intrinsics and corrects lens distortion. The new face preprocessing is a MediaPipe adaptation of the official dlib demo. Results measure this adaptation.

## Official assets

| Asset | Verified SHA-256 |
| --- | --- |
| epoch_24_ckpt.pth.tar, 290,663,093 bytes | f27b06dc22eb9c966a418f130b9f0df5083f81b44fc721197af5f0da8baeffd3 |
| face_model.txt | 15075125e5bb5573d5719cf15f88b137ecc9f4f135e833841fa545824791f964 |
| face_landmarker.task | 64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff |

The official repository revision is 3abb72840deb954df1c4ea5d89f243d7bd0d085f. The checkpoint is publicly linked by the authors and loaded strictly with PyTorch weights_only. The training dataset is approval-gated. The repository licenses its code CC BY-NC-SA 4.0. ETH’s portal terms restrict supplied assets to noncommercial academic use and prohibit redistribution of original and converted model parameters. The public Drive attachment supplies no separate commercial redistribution grant. Confirm rights for the exact checkpoint before bundling or converting it for distribution. This experiment uses the researcher-published checkpoint directly and keeps all first-party video and per-frame outputs on the laptop. [Official repository](https://github.com/xucong-zhang/ETH-XGaze/tree/3abb72840deb954df1c4ea5d89f243d7bd0d085f) · [Checkpoint link](https://drive.google.com/file/d/1Ma6zJrECNTjo_mToZ5GKk7EF-0FS4nEC/view?usp=sharing) · [ETH project](https://ait.ethz.ch/xgaze) · [ETH terms](https://xgaze.ait.ethz.ch/)

## Reproduce

Use Python 3.12, MediaPipe 0.10.21, NumPy 1.26.4, SciPy 1.15.3 and PyAV 16.1.0. Tested Torch/Torchvision versions were 2.9.1+cpu/0.24.1+cpu on Windows and 2.14.1+cu132/0.29.1+cu132 on Vast. Run with the checkpoint, face model and pinned MediaPipe task in a local asset directory. Download the first two from the official sources and use Ojos’s existing MediaPipe asset. [Official face model](https://raw.githubusercontent.com/xucong-zhang/ETH-XGaze/3abb72840deb954df1c4ea5d89f243d7bd0d085f/face_model.txt) · [MediaPipe asset](https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task)

On Windows, reuse the original and repeat index.json files from the WebEyeTrack replay, or regenerate them with its pack.py from the supplied recording directories. The indexes align calibration targets to recorded webcam time and contain nine fit and five held-out targets. Run from this directory in PowerShell.

~~~powershell
$run = "$env:LOCALAPPDATA/Ojos/eth-xgaze-bench"
$indexes = "$env:LOCALAPPDATA/Ojos/webeyetrack-bench"
$recordings = "$env:USERPROFILE/Videos/Ojos test recordings"
$original = "$recordings/ojos-2026-11-21T16-58-54-523Z-V9MJNF/webcam.webm"
$repeat = "$recordings/ojos-2026-11-21T17-26-05-875Z-EbW9Bs/webcam.webm"
$python = "$run/native-venv/Scripts/python.exe"
$assets = @('--checkpoint',"$run/epoch_24_ckpt.pth.tar",'--face-model',"$run/face_model.txt",'--landmarker',"$run/face_landmarker.task")
foreach ($height in @(720,480)) {
  & $python bench.py @assets --height $height --output "$run/original-$height.jsonl" replay --index "$indexes/original/index.json" --video $original --rate 20
  & $python bench.py @assets --height $height --output "$run/repeat-$height.jsonl" replay --index "$indexes/repeat/index.json" --video $repeat --rate 20
}
& $python bench.py @assets --output "$run/reasoning-720.jsonl" replay --index "$indexes/original/index.json" --video $original --window reasoning --rate 20
node score.mjs local $run $indexes "$run/local-metrics.json"
~~~

On Vast, the supervised run used the existing MPIIFaceGaze archive and exactly the image names selected by the WebEyeTrack public replay. To reproduce under the shared GPU lock, run the following command from this directory or the staged directory using the isolated environment. The CPU side uses the same command with --device cpu and a separate output file.

~~~sh
flock /workspace/ojos-training.gpu.lock .venv/bin/python -u bench.py   --checkpoint epoch_24_ckpt.pth.tar --face-model face_model.txt   --landmarker /workspace/ojos-data/eye-tracking/face_landmarker.task   --device cuda --output public-gpu.jsonl public   --archive /workspace/ojos-data/eye-tracking/Data.zip   --match /workspace/ojos-runs/eye-tracking/webeyetrack-public/cpu
node score.mjs public public-gpu.jsonl   /workspace/ojos-runs/eye-tracking/mpiifacegaze-v1/observations   /workspace/ojos-runs/eye-tracking/webeyetrack-public/cpu public-gpu-metrics.json
~~~

For the architecture comparison, clone the official source, check out the revision above and run parity.py with --upstream and --checkpoint. The observed maximum absolute output difference on the two seeded synthetic face inputs was 0 radians.

## How to read the metrics

Public calibration reproduces the same first-three-days fit and validation bins. It picks the five closest images per bin within 10% of the screen diagonal. Later-day evaluation is paired across all three pipelines. The public results use two participants, and compare held-out days rather than independent pretraining participants. Local calibration uses identical frame timestamp selection, nine fit windows, medians, Ojos’s held-out gate and uncertainty radius, and five held-out windows. Out-of-range predictions contribute to pixel error. All five validation positions must be in bounds for the gate to pass. The replay use of a failed fit appears as a diagnostic. Reasoning has no fixation labels and establishes coverage and dropout only. The same Ojos causal median and 5 Hz exporter are used for scoring; strict interpolation requires less than 100 ms between valid samples.

The CPU/GPU service measurements are unpaced batch-one replay. They include host-to-device input and synchronous result readback for CUDA. The main stage clock starts after video/JPEG decoding. Separate wall-clock FPS includes decoding. Neither includes camera acquisition, render-thread load, or network and queue delay. The model adds a ResNet and geometric homography to the existing landmark stage. An Ojos adapter must package compatible assets under appropriate rights, key calibration to checkpoint version and camera/viewport geometry, publish invalid points on face, blink, pose or projection failure, and pass coordinates and p80 uncertainty to the existing protocol. No browser implementation was tested.

See [measured results](RESULTS.md).
