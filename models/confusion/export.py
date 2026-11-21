"""Export and validate the incremental ONNX model and preprocessing contract."""

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch

from model import HIDDEN, ConfusionModel
from preprocess import DETECTOR_SIZE, MEAN, SIZE, STD, YUNET_SHA256, YUNET_URL, normalize

INPUTS = ["frame_rgb", "state_in"]
OUTPUTS = ["probabilities", "state_out"]


@torch.inference_mode()
def parity(model, graph):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    session = ort.InferenceSession(str(graph), options, providers=["CPUExecutionProvider"])
    for ports, names, shapes in (
        (session.get_inputs(), INPUTS, [[1, 3, SIZE, SIZE], [1, 1, HIDDEN]]),
        (session.get_outputs(), OUTPUTS, [[1, 2], [1, 1, HIDDEN]]),
    ):
        if [(port.name, port.shape, port.type) for port in ports] != [
            (name, shape, "tensor(float)") for name, shape in zip(names, shapes)
        ]:
            raise ValueError("Incremental ONNX input or output contract mismatch")
    frames = np.random.default_rng(2026).integers(0, 256, (24, SIZE, SIZE, 3), dtype=np.uint8)
    state = np.zeros((1, 1, HIDDEN), dtype=np.float32)
    max_error = dict.fromkeys(OUTPUTS, 0.0)
    for index, frame in enumerate(frames):
        if index in (0, 16):
            state.fill(0)
            torch_state = torch.from_numpy(state.copy())
        image = normalize(frame)[None].copy()
        expected, torch_state = model(torch.from_numpy(image), torch_state)
        obtained, state = session.run(OUTPUTS, dict(zip(INPUTS, (image, state))))
        for name, reference, actual in zip(OUTPUTS, (expected.numpy(), torch_state.numpy()), (obtained, state)):
            np.testing.assert_allclose(actual, reference, rtol=1e-4, atol=2e-5)
            max_error[name] = max(max_error[name], float(np.abs(actual - reference).max()))
    return {"frames": len(frames), "reset_before_frame": 16, "max_absolute_error": max_error}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("checkpoint", type=Path)
    p.add_argument("output", type=Path)
    args = p.parse_args()
    torch.set_num_threads(2)
    saved = torch.load(args.checkpoint, map_location="cpu", weights_only=True)
    if saved["mode"] != "gru":
        p.error("Incremental export requires a GRU checkpoint")
    args.output.mkdir(parents=True)
    model = ConfusionModel()
    model.load_state_dict(saved["weights"])
    model.eval()
    graph = args.output / "confusion.onnx"
    inputs = (torch.zeros(1, 3, SIZE, SIZE), torch.zeros(1, 1, HIDDEN))
    torch.onnx.export(model, inputs, graph, input_names=INPUTS, output_names=OUTPUTS, opset_version=17,
                      dynamo=False)
    onnx.checker.check_model(graph)
    result = parity(model, graph)
    metadata = {k: v for k, v in saved.items() if k != "weights"}
    metadata.update({"schema_version": 1, "onnx_sha256": hashlib.sha256(graph.read_bytes()).hexdigest(),
                     "normalization": {"mean": MEAN, "std": STD, "divisor": 255}, "class_index": 1,
                     "yunet": {"url": YUNET_URL, "sha256": YUNET_SHA256, "license": "MIT",
                               "input_width": DETECTOR_SIZE, "input_height": DETECTOR_SIZE},
                     "runtime": "onnxruntime-cpu", "opset": 17, "parity": result})
    if saved["dataset"] == "devemo-plus":
        metadata["research_data"] = {"source": "https://doi.org/10.5281/zenodo.21293919", "license": "CC BY-NC 4.0"}
    elif saved["dataset"] == "daisee":
        metadata["research_data"] = {"source": "https://people.iith.ac.in/vineethnb/resources/daisee/",
                                     "terms": "Research use only"}
    (args.output / "confusion.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
