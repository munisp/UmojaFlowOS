"""Real training loop for FraudNet (transaction fraud classifier)."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn

from ..features import (CATEGORICAL_FEATURES, NUMERIC_FEATURES, VOCAB,
                        build_feature_frame, encode_categoricals)
from ..models import FraudNet
from .common import EarlyStopper, TrainResult, classification_metrics, save_artifact, standardize, write_run_manifest


def _tensors(frame: pd.DataFrame, x_num: np.ndarray):
    cats = encode_categoricals(frame)
    return (
        torch.from_numpy(x_num),
        {k: torch.from_numpy(v) for k, v in cats.items()},
    )


def train_fraud_model(
    txns: pd.DataFrame,
    weights_dir: Path | str,
    version: str,
    kyc_by_account: dict[str, int] | None = None,
    epochs: int = 60,
    batch_size: int = 1024,
    lr: float = 2e-3,
    seed: int = 42,
    patience: int = 8,
    max_train_rows: int = 400_000,
) -> TrainResult:
    torch.manual_seed(seed)
    np.random.seed(seed)
    frame = build_feature_frame(txns, kyc_by_account)
    y = frame["label_fraud"].to_numpy().astype(np.float32)

    # time-based split: last 20% of timestamps is validation
    order = np.argsort(pd.to_datetime(frame["ts"]).to_numpy())
    cut = int(len(order) * 0.8)
    train_idx, val_idx = order[:cut], order[cut:]
    if len(train_idx) > max_train_rows:
        rng = np.random.default_rng(seed)
        train_idx = rng.choice(train_idx, max_train_rows, replace=False)

    x_all = frame[NUMERIC_FEATURES].to_numpy().astype(np.float32)
    x_tr, x_va, mu, sd = standardize(x_all[train_idx], x_all[val_idx])
    xn_tr, xc_tr = _tensors(frame.iloc[train_idx].reset_index(drop=True), x_tr)
    xn_va, xc_va = _tensors(frame.iloc[val_idx].reset_index(drop=True), x_va)
    y_tr = torch.from_numpy(y[train_idx])
    y_va = y[val_idx]

    pos_rate = max(y[train_idx].mean(), 1e-4)
    pos_weight = torch.tensor([(1 - pos_rate) / pos_rate], dtype=torch.float32)

    vocab_sizes = {c: len(VOCAB[c]) for c in CATEGORICAL_FEATURES}
    model = FraudNet(n_numeric=len(NUMERIC_FEATURES), vocab_sizes=vocab_sizes)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    stopper = EarlyStopper(patience=patience)

    n = xn_tr.shape[0]
    gen = torch.Generator().manual_seed(seed)
    epochs_run = 0
    for epoch in range(epochs):
        model.train()
        perm = torch.randperm(n, generator=gen)
        for start in range(0, n, batch_size):
            b = perm[start:start + batch_size]
            logits = model(xn_tr[b], {k: v[b] for k, v in xc_tr.items()})
            loss = loss_fn(logits, y_tr[b])
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
        sched.step()
        epochs_run = epoch + 1

        model.eval()
        with torch.no_grad():
            scores = []
            for start in range(0, xn_va.shape[0], 8192):
                s = model.predict_proba(xn_va[start:start + 8192], {k: v[start:start + 8192] for k, v in xc_va.items()})
                scores.append(s.numpy())
            val_score = np.concatenate(scores)
        metrics = classification_metrics(y_va, val_score)
        if stopper.step(metrics["pr_auc"], model):
            break

    stopper.restore(model)
    model.eval()
    with torch.no_grad():
        scores = []
        for start in range(0, xn_va.shape[0], 8192):
            s = model.predict_proba(xn_va[start:start + 8192], {k: v[start:start + 8192] for k, v in xc_va.items()})
            scores.append(s.numpy())
    final_metrics = classification_metrics(y_va, np.concatenate(scores))

    result = save_artifact(
        model=model, weights_dir=Path(weights_dir), model_name="fraud_net", version=version,
        metrics=final_metrics,
        feature_config={
            "numeric": NUMERIC_FEATURES, "categorical": CATEGORICAL_FEATURES,
            "vocab": VOCAB, "norm_mean": mu.tolist(), "norm_std": sd.tolist(),
        },
        training_window=f"{frame['ts'].min()}..{frame['ts'].max()}",
        data_provenance="synthetic_nigeria generator (NIBSS-shaped distributions, labelled fraud typologies)",
        n_train=len(train_idx), n_val=len(val_idx), epochs_run=epochs_run, seed=seed,
    )
    write_run_manifest(Path(weights_dir), {
        "model": "fraud_net", "version": version, "metrics": final_metrics,
        "epochs_run": epochs_run, "early_stopped": epochs_run < epochs,
    })
    return result
