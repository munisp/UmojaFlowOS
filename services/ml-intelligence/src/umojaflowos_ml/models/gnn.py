"""MuleGraphSAGE: GraphSAGE-style GNN for mule-account detection.

Pure-PyTorch implementation (no torch_geometric dependency) so it trains and
serves on CPU. Two message-passing layers with mean aggregation over the
directed flow graph, plus optional edge-feature injection at layer 1.
"""
from __future__ import annotations

import torch
import torch.nn as nn
import torch.nn.functional as F


def mean_aggregate(x: torch.Tensor, edge_index: torch.Tensor, num_nodes: int) -> torch.Tensor:
    """Mean of source-neighbour features for each destination node."""
    src, dst = edge_index[0], edge_index[1]
    agg = torch.zeros_like(x)
    agg.index_add_(0, dst, x[src])
    deg = torch.zeros(num_nodes, device=x.device, dtype=x.dtype)
    deg.index_add_(0, dst, torch.ones_like(dst, dtype=x.dtype))
    deg = deg.clamp_(min=1.0).unsqueeze(-1)
    return agg / deg


class SAGELayer(nn.Module):
    def __init__(self, in_dim: int, out_dim: int):
        super().__init__()
        self.self_lin = nn.Linear(in_dim, out_dim)
        self.neigh_lin = nn.Linear(in_dim, out_dim)

    def forward(self, x: torch.Tensor, edge_index: torch.Tensor) -> torch.Tensor:
        neigh = mean_aggregate(x, edge_index, x.size(0))
        return F.gelu(self.self_lin(x) + self.neigh_lin(neigh))


class MuleGraphSAGE(nn.Module):
    def __init__(self, n_node_features: int, hidden: int = 64, n_classes: int = 2, dropout: float = 0.2):
        super().__init__()
        self.in_norm = nn.LayerNorm(n_node_features)
        self.conv1 = SAGELayer(n_node_features, hidden)
        self.conv2 = SAGELayer(hidden, hidden)
        self.dropout = nn.Dropout(dropout)
        self.head = nn.Linear(hidden, n_classes)

    def forward(self, x: torch.Tensor, edge_index: torch.Tensor) -> torch.Tensor:
        h = self.in_norm(x)
        h = self.dropout(self.conv1(h, edge_index))
        h = self.conv2(h, edge_index)
        return self.head(h)

    @torch.no_grad()
    def predict_proba(self, x: torch.Tensor, edge_index: torch.Tensor) -> torch.Tensor:
        return torch.softmax(self.forward(x, edge_index), dim=-1)[:, 1]
