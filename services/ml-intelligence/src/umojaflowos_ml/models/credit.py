"""CreditNet: multitask credit-risk network.

Two heads share a representation:
  * PD head  -> probability of default (sigmoid)
  * band head -> 5-band credit score classification (softmax), bands A..E

Advisory only: supports human credit review; never auto-approves or declines.
"""
from __future__ import annotations

import torch
import torch.nn as nn


class CreditNet(nn.Module):
    def __init__(self, n_features: int, hidden: int = 96, n_bands: int = 5):
        super().__init__()
        self.n_bands = n_bands
        self.trunk = nn.Sequential(
            nn.Linear(n_features, hidden), nn.GELU(), nn.Dropout(0.10),
            nn.Linear(hidden, hidden), nn.GELU(),
        )
        self.pd_head = nn.Linear(hidden, 1)
        self.band_head = nn.Linear(hidden, n_bands)

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        h = self.trunk(x)
        pd_logit = self.pd_head(h).squeeze(-1)
        band_logits = self.band_head(h)
        return pd_logit, band_logits

    @torch.no_grad()
    def score(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """Returns (probability_of_default, band_index 0=A best .. 4=E worst)."""
        pd_logit, band_logits = self.forward(x)
        return torch.sigmoid(pd_logit), band_logits.argmax(dim=-1)
