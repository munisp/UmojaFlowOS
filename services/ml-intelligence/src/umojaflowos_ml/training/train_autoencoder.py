"""Real training loop for FraudAutoencoder (deep anomaly detection)."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import torch
import torch.nn as nn

from ..features import (CATEGORICAL_FEATURES, NUMERIC_FEATURES, VOCAB,
                        build_feature_frame, encode_categoricals)
from ..models import FraudAutoencoder
from .common import EarlyStopper, TrainResult, classification_metrics, save_artifact, standardize, write_run_manifest


def train_autoencoder_model(
    txns: pd.DataFrame,
    weights_dir: Path | str,
    version: str,
    kyc_by_account: dict[str, int] | None = None,
    epochs: int = 40,
    batch_size: int = 1024,
    lr: float = 2e-3,
    seed: int = 42,
    patience: int = 6,
    max_train_rows: int = 300_000,
) -> TrainResult:
    torch.manual_seed(seed)
    np.random.seed(seed)
    frame = build_feature_frame(txns, kyc_by_account)
    y = frame["label_fraud"].to_numpy().astype(np.float32)

    # train ONLY on legitimate transactions (anomaly detection)
    legit = frame[frame["label_fraud"] == 0]
    if len(legit) > max_train_rows:
        legit = legit.sample(max_train_rows, random_state=seed)
    order = np.argsort(pd.to_datetime(legit["ts"]).to_numpy())
    cut = int(len(order) * 0.85)
    tr_idx, va_legit_idx = order[:cut], order[cut:]

    x_all = legit[NUMERIC_FEATURES].to_numpy().astype(np.float32)
    x_tr, x_va, mu, sd = standardize(x_all[tr_idx], x_all[va_legit_idx])

    # validation for scoring includes held-out fraud to verify separation
    fraud_holdout = frame[frame["label_fraud"] == 1].sample(
        min(2000, max(1, (frame["label_fraud"] == 1).sum())), random_state=seed)
    x_fraud = ((fraud_holdout[NUMERIC_FEATURES].to_numpy().astype(np.float32) - mu) / sd).astype(np.float32)

    def to_tensors(df, xn):
        cats = encode_categoricals(df)
        return torch.from_numpy(xn), {k: torch.from_numpy(v) for k, v in cats.items()}

    legit_tr = legit.iloc[tr_idx].reset_index(drop=True)
    legit_va = legit.iloc[va_legit_idx].reset_index(drop=True)
    xn_tr, xc_tr = to_tensors(legit_tr, x_tr)
    xn_va, xc_va = to_tensors(legit_va, x_va)
    xn_fr, xc_fr = to_tensors(fraud_holdout.reset_index(drop=True), x_fraud)

    vocab_sizes = {c: len(VOCAB[c]) for c in CATEGORICAL_FEATURES}
    model = FraudAutoencoder(n_numeric=len(NUMERIC_FEATURES), vocab_sizes=vocab_sizes)
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-5)
    loss_fn = nn.MSELoss()
    stopper = EarlyStopper(patience=patience)

    n = xn_tr.shape[0]
    gen = torch.Generator().manual_seed(seed)
    epochs_run = 0
    for epoch in range(epochs):
        model.train()
        perm = torch.randperm(n, generator=gen)
        for start in range(0, n, batch_size):
            b = perm[start:start + batch_size]
            recon = model(xn_tr[b], {k: v[b] for k, v in xc_tr.items()})
            target = model._embed(xn_tr[b], {k: v[b] for k, v in xc_tr.items()})
            loss = loss_fn(recon, target)
            opt.zero_grad()
            loss.backward()
            opt.step()
        epochs_run = epoch + 1

        model.eval()
        with torch.no_grad():
            va_scores = []
            for start in range(0, xn_va.shape[0], 8192):
                va_scores.append(model.anomaly_score(xn_va[start:start + 8192], {k: v[start:start + 8192] for k, v in xc_va.items()}).numpy())
            fr_scores = model.anomaly_score(xn_fr, xc_fr).numpy()
        y_eval = np.concatenate([np.zeros(len(np.concatenate(va_scores))), np.ones(len(fr_scores))])
        s_eval = np.concatenate([np.concatenate(va_scores), fr_scores])
        m = classification_metrics(y_eval, s_eval)
        if stopper.step(m["roc_auc"], model):
            break

    stopper.restore(model)
    model.eval()
    with torch.no_grad():
        va_scores = []
        for start in range(0, xn_va.shape[0], 8192):
            va_scores.append(model.anomaly_score(xn_va[start:start + 8192], {k: v[start:start + 8192] for k, v in xc_va.items()}).numpy())
        fr_scores = model.anomaly_score(xn_fr, xc_fr).numpy()
    va_cat = np.concatenate(va_scores)
    y_eval = np.concatenate([np.zeros(len(va_cat)), np.ones(len(fr_scores))])
    s_eval = np.concatenate([va_cat, fr_scores])
    final = classification_metrics(y_eval, s_eval)
    # operating threshold: 99th percentile of legit reconstruction error
    threshold = float(np.quantile(va_cat, 0.99))
    final["alert_rate_at_threshold"] = float((s_eval >= threshold).mean())
    final["fraud_catch_rate_at_threshold"] = float((fr_scores >= threshold).mean())

    result = save_artifact(
        model=model, weights_dir=Path(weights_dir), model_name="fraud_autoencoder", version=version,
        metrics=final,
        feature_config={
            "numeric": NUMERIC_FEATURES, "categorical": CATEGORICAL_FEATURES, "vocab": VOCAB,
            "norm_mean": mu.tolist(), "norm_std": sd.tolist(), "anomaly_threshold": threshold,
        },
        training_window=f"{frame['ts'].min()}..{frame['ts'].max()}",
        data_provenance="trained on legitimate-only synthetic_nigeria traffic; validated against held-out fraud",
        n_train=len(tr_idx), n_val=len(va_legit_idx) + len(fr_scores), epochs_run=epochs_run, seed=seed,
    )
    write_run_manifest(Path(weights_dir), {"model": "fraud_autoencoder", "version": version, "metrics": final, "epochs_run": epochs_run})
    return result
