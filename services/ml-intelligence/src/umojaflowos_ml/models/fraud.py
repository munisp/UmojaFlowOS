"""FraudNet: transaction-level fraud classifier.

Numeric features are standardized, categorical features are embedded, then a
residual MLP produces a fraud logit. Sized for CPU inference (<1M params).
"""
from __future__ import annotations

import torch
import torch.nn as nn


class FraudNet(nn.Module):
    def __init__(self, n_numeric: int, vocab_sizes: dict[str, int], emb_dim: int = 8, hidden: int = 128):
        super().__init__()
        self.vocab_sizes = vocab_sizes
        self.embeddings = nn.ModuleDict({
            name: nn.Embedding(size, emb_dim) for name, size in vocab_sizes.items()
        })
        in_dim = n_numeric + emb_dim * len(vocab_sizes)
        self.input_norm = nn.LayerNorm(in_dim)
        self.body = nn.Sequential(
            nn.Linear(in_dim, hidden), nn.GELU(), nn.Dropout(0.15),
            nn.Linear(hidden, hidden), nn.GELU(), nn.Dropout(0.15),
        )
        self.residual = nn.Linear(in_dim, hidden)
        self.head = nn.Linear(hidden, 1)

    def forward(self, x_num: torch.Tensor, x_cat: dict[str, torch.Tensor]) -> torch.Tensor:
        embs = [self.embeddings[name](x_cat[name]) for name in self.embeddings]
        z = torch.cat([x_num, *embs], dim=-1)
        z = self.input_norm(z)
        h = self.body(z) + self.residual(z)
        return self.head(h).squeeze(-1)

    @torch.no_grad()
    def predict_proba(self, x_num: torch.Tensor, x_cat: dict[str, torch.Tensor]) -> torch.Tensor:
        return torch.sigmoid(self.forward(x_num, x_cat))
