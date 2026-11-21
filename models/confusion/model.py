"""MobileNetV3-Small features with either an incremental GRU or a frame head."""

import torch
from torch import nn
from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

FEATURES = 576
HIDDEN = 128


class ConfusionModel(nn.Module):
    def __init__(self, mode="gru", pretrained=False):
        super().__init__()
        if mode not in ("gru", "cnn"):
            raise ValueError(f"Unknown model mode: {mode}")
        self.mode = mode
        weights = MobileNet_V3_Small_Weights.IMAGENET1K_V1 if pretrained else None
        backbone = mobilenet_v3_small(weights=weights)
        self.features = backbone.features
        self.pool = backbone.avgpool
        self.projection = nn.Linear(FEATURES, HIDDEN)
        self.gru = nn.GRU(HIDDEN, HIDDEN, batch_first=True) if mode == "gru" else None
        self.classifier = nn.Linear(HIDDEN, 2)

    def encode(self, images):
        return self.projection(self.pool(self.features(images)).flatten(1))

    def classify(self, projected, state=None):
        if self.gru is not None:
            projected, _ = self.gru(projected, state)
        return self.classifier(projected), projected

    def forward(self, frame_rgb, state_in):
        """Incremental graph, with one normalized RGB frame per call."""
        if self.gru is None:
            raise ValueError("Incremental inference requires a GRU")
        projected = self.encode(frame_rgb).unsqueeze(1)
        logits, hidden = self.classify(projected, state_in)
        return logits[:, 0].softmax(-1), hidden.transpose(0, 1)
