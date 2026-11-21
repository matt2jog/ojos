# Ojos confusion model

The research pipeline takes timestamped camera frames through YuNet, eye alignment, a 112 × 112 RGB crop, and MobileNetV3-Small. It pools 576 features, projects to 128, and uses one unidirectional GRU with 128 hidden units and a binary softmax. Training carries detached state across four-second chunks within each face track and resets at track boundaries. The pooled CNN applies the same frame encoder and classification head without the GRU. The clip objective and evaluation pool the class-1 probabilities of usable frames. [Vision specification](../../docs/vision.md)

## DevEmo+ results

This run used DevEmo+ v2 for a noncommercial debugging-domain benchmark while DAiSEE access was pending. The verified archive contains 304 files and 304 metadata rows across 51 reported participants. The rows contain 79 confusion, 152 neutral, 34 happiness, 25 surprise, nine disgust, and five anger labels. The benchmark used explicit confusion and neutral labels, excluding the 73 other annotations. Two neutral rows point to `devemo+_165.mp4` with different participant IDs, and `devemo+_166.mp4` has no metadata row. Both media files were excluded. [Dataset record and attribution](https://doi.org/10.5281/zenodo.21293919) · [Data paper](https://doi.org/10.1038/s41597-026-08065-7) · [Dataset license](https://devemo.affectivese.org/)

| Split | People | Confusion | Neutral | Clips with usable frames at 8 Hz | Usable sampled faces at 8 Hz |
| --- | ---: | ---: | ---: | ---: | ---: |
| Train | 35 | 55 | 104 | 151/159 | 5,842/6,336 |
| Validation | 7 | 12 | 23 | 35/35 | 1,363/1,384 |
| Test | 8 | 12 | 23 | 35/35 | 1,415/1,416 |

The participant split is seeded and shared across all four models. Each run fine-tuned ImageNet-initialized weights for eight epochs on the A100. Validation average precision selected the checkpoint. The test set had a 65.7% majority baseline and all 35 clips yielded scores at each cadence. The fixed threshold was 0.5 for clip metrics.

| Model | Accuracy | Balanced accuracy | Average precision | ROC AUC | Correctly identified confusion clips |
| --- | ---: | ---: | ---: | ---: | ---: |
| GRU at 4 Hz | 60.0% | 55.6% | 0.635 | 0.707 | 5/12 |
| GRU at 8 Hz | 60.0% | 55.6% | 0.595 | 0.692 | 5/12 |
| GRU at 16 Hz | 60.0% | 55.6% | 0.613 | 0.721 | 5/12 |
| Pooled CNN at 8 Hz | 65.7% | 58.0% | 0.608 | 0.746 | 4/12 |

The held-out 16 Hz pass skipped 235 cadence ticks due to gaps between source frames. These are clip recognition results on a small held-out group. Continuous help-wanted interval performance, webcam coverage and throughput on target laptops, and throughput with gaze and screen recording active remain unmeasured. Keep the DevEmo+ weights and exports for noncommercial research.

## Data access

| Dataset | Access and evidence |
| --- | --- |
| DAiSEE | IIT Hyderabad's registration form requires a name, official email, role, affiliation and intended use. Submitting it accepts its research-only and redistribution terms. The authors report 9,068 clips from 112 people with confusion levels distributed as 6,024 / 2,191 / 752 / 101. Those are paper totals. The official release split and its counts await authorized access. [Terms](https://people.iith.ac.in/vineethnb/resources/daisee/) · [Registration](https://docs.google.com/forms/d/e/1FAIpQLSeRIjWnqBNqhFaIMnmUshkQJ6gH_HWuN425JRK_WYTPJ1pSHQ/viewform) · [Paper](https://arxiv.org/html/1609.01885) |
| DevEmo | Access by request to `michal.wrobel@pg.edu.pl` with the subject “DevEmo dataset access request” from an academic address or with a description of the intended use. The authors report 217 clips from 33 people, including 56 confusion and 108 neutral clips. [Access](https://devemo.affectivese.org/) · [Paper](https://doi.org/10.3390/app13063839) |
| OL-SFED | Request access from the corresponding author, `luweigang@ouc.edu.cn`. The paper describes research consent and reports 1,274 clips from 82 people, including 267 confusion and 237 neutral clips. Access and data-use terms still need confirmation from the authors. [Paper](https://doi.org/10.1049/iet-cvi.2018.5281) |

## Reproduce on Vast

Run from the repository root. Use the model-specific venv with the Vast PyTorch installation as its base.

```sh
data=/workspace/ojos-data/confusion
runs=/workspace/ojos-runs/confusion
mkdir -p "$data/assets" "$runs"
/venv/main/bin/python -m venv --system-site-packages "$runs/venv"
uv pip install --python "$runs/venv/bin/python" -r models/confusion/requirements.txt
curl -fL -o "$data/assets/face_detection_yunet_2023mar.onnx" \
  https://huggingface.co/opencv/face_detection_yunet/resolve/3cc26e7f1014a5ee5d74a42acee58bafc9d0a310/face_detection_yunet_2023mar.onnx
curl -fL -o "$data/devemo-plus-v2.zip" 'https://zenodo.org/records/21293919/files/devemo%2B.zip?download=1'
(cd "$data" && echo 'c0c1f173805db03932a0bafaad6bbd85  devemo-plus-v2.zip' | md5sum -c)
unzip -n "$data/devemo-plus-v2.zip" -d "$data"
```

Run the following as distinct supervisor jobs, starting training after the prepared manifests exist. Use new output directories for a rerun. All GPU runs in the training matrix acquire `/workspace/ojos-training.gpu.lock` for the duration of each run. Training logs, checkpoints, per-clip predictions and metrics live under `/workspace/ojos-runs/confusion`. Prepared manifests include coverage and counts per participant.

```sh
bash models/confusion/run_matrix.sh prepare "$runs/venv/bin/python"
bash models/confusion/run_matrix.sh train "$runs/venv/bin/python"
"$runs/venv/bin/python" models/confusion/export.py \
  "$runs/devemo-gru-8hz/best.pt" "$runs/devemo-gru-8hz/onnx-verified"
```

For authorized DAiSEE research, pass the official archive or the directory containing `Labels/` and `DataSet/` to `prepare.py daisee`. This reads the official split CSVs and assigns levels 2–3 to class 1 and 0–1 to class 0. A ZIP can be read one video at a time. Keep the roughly 15 GB archive on external storage with enough space for the face cache. `--max-clips-per-class` caps preprocessing for a pipeline check and changes the evaluated test prevalence. Evaluate the full official split for the reported benchmark. The DAiSEE adapter passed a synthetic archive test and awaits verification on the official archive.

## Runtime and replay

`runtime.ConfusionRuntime` is the Python reference for the vision worker. Call `start_epoch(capture_epoch)` after a source or clock discontinuity, then feed BGR frames with session-relative source time in microseconds and increasing frame IDs via `process`. Send returned messages to the desktop's vision callback. Diagnostics expose quality reasons, usable face coverage, effective sampling rate and skipped ticks. Geometry, exposure, blur, multiple-face and track-change thresholds are initial heuristics. The worker letterboxes to 320 × 320 for YuNet, aligns the eyes, and crops with 20% margin per side. Keep the pinned MIT YuNet license alongside the asset. [YuNet model and license](https://huggingface.co/opencv/face_detection_yunet) · [Session and event protocol](../../docs/protocol.md)

The ONNX input names and FP32 shapes are `frame_rgb[1,3,112,112]` and `state_in[1,1,128]`. Outputs are `probabilities[1,2]` and `state_out[1,1,128]`. RGB channels are divided by 255 and normalized with ImageNet mean and standard deviation, recorded in `confusion.json` along with the cadence, model checksum, and YuNet checksum. The export verifies names, dtypes, dimensions, and CPU ONNX Runtime parity across 24 sequential frames, resetting before frame 16. Across the three trained GRUs, the largest absolute differences were 1.64 × 10⁻⁷ in probabilities and 5.36 × 10⁻⁷ in recurrent state.

Run a local video through the trained model and interval state machine. Each replay uses a fresh session ID by default and emits replay events as JSONL. The recovery trace remains a regression test for the interval state machine.

```sh
python models/confusion/replay.py video <local-video> <export-directory> <yunet-onnx>
python -m unittest discover -s models/confusion -v
```

`evaluate_intervals.py` takes a JSON array of continuous held-out sessions. Each session carries `session_id`, `participant`, `domain`, `duration_us`, `sampled_frames`, `usable_frames`, and `skipped_ticks`. Supply `help_wanted` spans with `capture_epoch`, `start_us` and `end_us`, and a `published` list of `{"event": {...}, "published_us": ...}` records using live events. Use continuous reviewed sessions and count their full duration for false panes per hour. The evaluator matches one-to-one at temporal IoU ≥ 0.30 and reports precision, recall, false panes per hour, onset and publication delays, and coverage by domain and participant.
