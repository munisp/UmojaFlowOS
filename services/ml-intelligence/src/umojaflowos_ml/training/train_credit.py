"""Real training loop for CreditNet (multitask PD + score-band model)."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn

from ..features import CREDIT_FEATURES, credit_feature_frame
from ..models import CreditNet
from .common import EarlyStopper, TrainResult, classification_metrics, save_artifact, standardize, write_run_manifest


def train_credit_model(
    txns: pd.DataFrame,
    accounts: pd.DataFrame,
    weights_dir: Path | str,
    version: str,
    epochs: int = 50,
    batch_size: int = 512,
    lr: float = 2e-3,
    seed: int = 42,
    patience: int = 8,
) -> TrainResult:
    torch.manual_seed(seed)
    np.random.seed(seed)
    feats = credit_feature_frame(txns, accounts)
    y_default = accounts.set_index("account_id").loc[feats["account_id"], "credit_default"].to_numpy().astype(np.float32)
    # band labels from PD-like stress: A best (0) .. E worst (4), derived from default quintiles proxy
    stress = feats["spend_ratio"].to_numpy() + feats["gambling_txns"].to_numpy() * 0.3 + feats["loan_app_txns"].to_numpy() * 0.3
    y_band = np.clip((stress / (np.quantile(stress, 0.99) + 1e-9) * 5).astype(int), 0, 4).astype(np.int64)

    x_all = feats[CREDIT_FEATURES].to_numpy().astype(np.float32)
    rng = np.random.default_rng(seed)
    perm = rng.permutation(len(feats))
    cut = int(len(feats) * 0.8)
    tr, va = perm[:cut], perm[cut:]
    x_tr, x_va, mu, sd = standardize(x_all[tr], x_all[va])
    yd_tr = torch.from_numpy(y_default[tr])
    yb_tr = torch.from_numpy(y_band[tr])
    yd_va = y_default[va]

    pos_rate = max(y_default[tr].mean(), 1e-4)
    pos_weight = torch.tensor([(1 - pos_rate) / pos_rate], dtype=torch.float32)

    model = CreditNet(n_features=len(CREDIT_FEATURES))
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    pd_loss = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    band_loss = nn.CrossEntropyLoss()
    stopper = EarlyStopper(patience=patience)

    xtr = torch.from_numpy(x_tr)
    n = xtr.shape[0]
    gen = torch.Generator().manual_seed(seed)
    epochs_run = 0
    for epoch in range(epochs):
        model.train()
        p = torch.randperm(n, generator=gen)
        for start in range(0, n, batch_size):
            b = p[start:start + batch_size]
            pd_logit, band_logits = model(xtr[b])
            loss = pd_loss(pd_logit, yd_tr[b]) + 0.4 * band_loss(band_logits, yb_tr[b])
            opt.zero_grad()
            loss.backward()
            opt.step()
        epochs_run = epoch + 1

        model.eval()
        with torch.no_grad():
            pd_va, _ = model.score(torch.from_numpy(x_va))
        m = classification_metrics(yd_va, pd_va.numpy())
        if stopper.step(m["roc_auc"], model):
            break

    stopper.restore(model)
    model.eval()
    with torch.no_grad():
        pd_va, band_va = model.score(torch.from_numpy(x_va))
    final = classification_metrics(yd_va, pd_va.numpy())
    final["band_accuracy"] = float((band_va.numpy() == y_band[va]).mean())

    result = save_artifact(
        model=model, weights_dir=Path(weights_dir), model_name="credit_net", version=version,
        metrics=final,
        feature_config={"numeric": CREDIT_FEATURES, "norm_mean": mu.tolist(), "norm_std": sd.tolist()},
        training_window=f"{txns['ts'].min()}..{txns['ts'].max()}",
        data_provenance="synthetic_nigeria generator account-level credit behaviour labels",
        n_train=len(tr), n_val=len(va), epochs_run=epochs_run, seed=seed,
    )
    write_run_manifest(Path(weights_dir), {"model": "credit_net", "version": version, "metrics": final, "epochs_run": epochs_run})
    return result
