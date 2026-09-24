"""Real training loop for MuleGraphSAGE (GNN mule-account detection)."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn

from ..graph_builder import NODE_FEATURES, build_graph
from ..models import MuleGraphSAGE
from .common import EarlyStopper, TrainResult, classification_metrics, save_artifact, write_run_manifest


def train_gnn_model(
    txns: pd.DataFrame,
    account_labels: dict[str, int],
    weights_dir: Path | str,
    version: str,
    kyc_by_account: dict[str, int] | None = None,
    epochs: int = 120,
    lr: float = 5e-3,
    seed: int = 42,
    patience: int = 15,
) -> TrainResult:
    torch.manual_seed(seed)
    graph = build_graph(txns, account_labels, kyc_by_account, seed=seed)
    x = torch.from_numpy(graph.x)
    edge_index = torch.from_numpy(graph.edge_index)
    y = torch.from_numpy(graph.y)
    train_mask = torch.from_numpy(graph.train_mask)
    val_mask = torch.from_numpy(graph.val_mask)

    n_pos = max(int(y[train_mask].sum()), 1)
    n_neg = int((~y.bool() & train_mask).sum())
    class_weight = torch.tensor([1.0, n_neg / n_pos], dtype=torch.float32)

    model = MuleGraphSAGE(n_node_features=len(NODE_FEATURES))
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    loss_fn = nn.CrossEntropyLoss(weight=class_weight)
    stopper = EarlyStopper(patience=patience)

    epochs_run = 0
    for epoch in range(epochs):
        model.train()
        logits = model(x, edge_index)
        loss = loss_fn(logits[train_mask], y[train_mask])
        opt.zero_grad()
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        epochs_run = epoch + 1

        model.eval()
        with torch.no_grad():
            prob = model.predict_proba(x, edge_index).numpy()
        m = classification_metrics(y[val_mask].numpy(), prob[val_mask.numpy()])
        if stopper.step(m["pr_auc"], model):
            break

    stopper.restore(model)
    model.eval()
    with torch.no_grad():
        prob = model.predict_proba(x, edge_index).numpy()
    final = classification_metrics(y[val_mask].numpy(), prob[val_mask.numpy()])

    result = save_artifact(
        model=model, weights_dir=Path(weights_dir), model_name="mule_graphsage", version=version,
        metrics=final,
        feature_config={
            "node_features": NODE_FEATURES,
            "num_nodes": graph.num_nodes,
            "num_edges": int(graph.edge_index.shape[1]),
        },
        training_window=f"{txns['ts'].min()}..{txns['ts'].max()}",
        data_provenance="transaction graph built from synthetic_nigeria flows with mule labels",
        n_train=int(train_mask.sum()), n_val=int(val_mask.sum()), epochs_run=epochs_run, seed=seed,
    )
    write_run_manifest(Path(weights_dir), {"model": "mule_graphsage", "version": version, "metrics": final, "epochs_run": epochs_run})
    return result
