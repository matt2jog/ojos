#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 || ( "$1" != "prepare" && "$1" != "train" ) ]]; then
    echo "Usage: bash run_matrix.sh prepare|train /path/to/python" >&2
    exit 2
fi
action=$1
python=$2
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

data=${OJOS_CONFUSION_DATA:-/workspace/ojos-data/confusion}
runs=${OJOS_CONFUSION_RUNS:-/workspace/ojos-runs/confusion}
lock=${OJOS_GPU_LOCK:-/workspace/ojos-training.gpu.lock}
mkdir -p "$runs"
export TORCH_HOME="$data/assets/torch"

if [[ "$action" == "prepare" ]]; then
    for hz in 8 4 16; do
        "$python" -u prepare.py devemo-plus "$data/devemo+" "$data/assets/face_detection_yunet_2023mar.onnx" \
            "$data/devemo-${hz}hz" --hz "$hz" > "$runs/prepare-${hz}hz.log" 2>&1
    done
else
    for trial in gru:8 cnn:8 gru:4 gru:16; do
        IFS=: read -r mode hz <<< "$trial"
        name="devemo-${mode}-${hz}hz"
        printf 'Waiting for GPU for %s\n' "$name"
        flock "$lock" "$python" -u train.py "$data/devemo-${hz}hz" "$runs/$name" \
            --model "$mode" --workers 0 > "$runs/$name.log" 2>&1
        printf 'Finished %s\n' "$name"
    done
fi
