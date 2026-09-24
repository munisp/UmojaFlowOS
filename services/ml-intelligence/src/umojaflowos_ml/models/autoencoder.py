"""FraudAutoencoder: deep anomaly detector for novel fraud patterns.

Trained only on legitimate transactions; reconstruction error is the anomaly
score. Catches typologies the supervised classifier has never seen.
"""
from __future__ import annotations

import torch
import torch.nn as nn


class FraudAutoencoder(nn.Module):
    def __init__(self, n_numeric: int, vocab_sizes: dict[str, int], emb_dim: int = 8, latent: int = 16):
        super().__init__()
        self.embeddings = nn.ModuleDict({
            name: nn.Embedding(size, emb_dim) for name, size in vocab_sizes.items()
        })
        in_dim = n_numeric + emb_dim * len(vocab_sizes)
        self.in_dim = in_dim
        self.encoder = nn.Sequential(
            nn.Linear(in_dim, 64), nn.GELU(),
            nn.Linear(64, 32), nn.GELU(),
            nn.Linear(32, latent),
        )
        self.decoder = nn.Sequential(
            nn.Linear(latent, 32), nn.GELU(),
            nn.Linear(32, 64), nn.GELU(),
            nn.Linear(64, in_dim),
        )

    def _embed(self, x_num: torch.Tensor, x_cat: dict[str, torch.Tensor]) -> torch.Tensor:
        embs = [self.embeddings[name](x_cat[name]) for name in self.embeddings]
        return torch.cat([x_num, *embs], dim=-1)

    def forward(self, x_num: torch.Tensor, x_cat: dict[str, torch.Tensor]) -> torch.Tensor:
        z = self._embed(x_num, x_cat)
        return self.decoder(self.encoder(z))

    @torch.no_grad()
    def anomaly_score(self, x_num: torch.Tensor, x_cat: dict[str, torch.Tensor]) -> torch.Tensor:
        z = self._embed(x_num, x_cat)
        recon = self.decoder(self.encoder(z))
        return ((recon - z) ** 2).mean(dim=-1)
