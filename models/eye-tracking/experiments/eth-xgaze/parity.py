"""Check the pinned upstream forward pass against this port on a synthetic crop."""
import argparse
from pathlib import Path
import subprocess
import sys

import torch

from bench import CHECKPOINT_SHA, checked, load_model

UPSTREAM_SHA = "3abb72840deb954df1c4ea5d89f243d7bd0d085f"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--upstream", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    args = parser.parse_args()
    commit = subprocess.check_output(["git", "-C", str(args.upstream), "rev-parse", "HEAD"],
                                     text=True).strip()
    if commit != UPSTREAM_SHA:
        raise ValueError(f"Expected upstream commit {UPSTREAM_SHA}")
    sys.path.insert(0, str(args.upstream))
    import model as upstream

    torch.set_num_threads(2)
    factory = upstream.resnet50
    # The checkpoint replaces all parameters. Skip the upstream ImageNet fetch.
    upstream.resnet50 = lambda pretrained: factory(pretrained=False)
    official = upstream.gaze_network().eval()
    weights = torch.load(checked(args.checkpoint, CHECKPOINT_SHA), map_location="cpu", weights_only=True)
    official.load_state_dict(weights["model_state"], strict=True)
    experiment = load_model(args.checkpoint, torch.device("cpu"))
    pixels = torch.randn((2, 3, 224, 224), generator=torch.Generator().manual_seed(2026))
    with torch.inference_mode():
        expected = official(pixels)
        actual = experiment(pixels)
    torch.testing.assert_close(actual, expected, rtol=0, atol=1e-6)
    print(f"max_absolute_error_radians={(expected - actual).abs().max().item()}")


if __name__ == "__main__":
    main()
