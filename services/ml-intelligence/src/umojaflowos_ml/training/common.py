"""Shared training utilities: metrics, early stopping, artifact saving."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from sklearn.metrics import average_precision_score, f1_score, roc_auc_score

from ..schemas import TrainedArtifact, sha256_of, utcnow


@dataclass
class TrainResult:
    model: torch.nn.Module
    artifact: TrainedArtifact
    weights_path: Path
    metadata_path: Path


def classification_metrics(y_true: np.ndarray, y_score: np.ndarray, threshold: float = 0.5) -> dict[str, float]:
    y_pred = (y_score >= threshold).astype(int)
    out = {}
    if len(np.unique(y_true)) > 1:
        out["roc_auc"] = float(roc_auc_score(y_true, y_score))
        out["pr_auc"] = float(average_precision_score(y_true, y_score))
        # validation-optimal operating threshold (stored for calibrated serving)
        best_f1, best_t = 0.0, threshold
        for t in np.linspace(0.01, 0.99, 99):
            f1 = f1_score(y_true, (y_score >= t).astype(int), zero_division=0)
            if f1 > best_f1:
                best_f1, best_t = float(f1), float(t)
        out["best_f1"] = best_f1
        out["best_threshold"] = best_t
    else:
        out["roc_auc"] = 0.0
        out["pr_auc"] = 0.0
        out["best_f1"] = 0.0
        out["best_threshold"] = threshold
    out["f1"] = float(f1_score(y_true, y_pred, zero_division=0))
    out["positive_rate"] = float(y_true.mean())
    return out


class EarlyStopper:
    def __init__(self, patience: int = 8, min_delta: float = 1e-4):
        self.patience = patience
        self.min_delta = min_delta
        self.best = -np.inf
        self.bad_epochs = 0
        self.best_state: dict | None = None

    def step(self, score: float, model: torch.nn.Module) -> bool:
        if score > self.best + self.min_delta:
            self.best = score
            self.bad_epochs = 0
            self.best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
            return False
        self.bad_epochs += 1
        return self.bad_epochs >= self.patience

    def restore(self, model: torch.nn.Module) -> None:
        if self.best_state is not None:
            model.load_state_dict(self.best_state)


def save_artifact(
    model: torch.nn.Module,
    weights_dir: Path,
    model_name: str,
    version: str,
    metrics: dict[str, float],
    feature_config: dict,
    training_window: str,
    data_provenance: str,
    n_train: int,
    n_val: int,
    epochs_run: int,
    seed: int,
) -> TrainResult:
    weights_dir = Path(weights_dir)
    weights_dir.mkdir(parents=True, exist_ok=True)
    weights_path = weights_dir / f"{model_name}-{version}.pt"
    torch.save(model.state_dict(), weights_path)
    digest = sha256_of(weights_path.read_bytes())
    artifact = TrainedArtifact(
        model_name=model_name,
        version=version,
        trained_at=utcnow().isoformat(),
        weights_sha256=digest,
        metrics=metrics,
        feature_config=feature_config,
        training_window=training_window,
        data_provenance=data_provenance,
        n_train=n_train,
        n_val=n_val,
        epochs_run=epochs_run,
        seed=seed,
    )
    metadata_path = weights_dir / f"{model_name}-{version}.json"
    metadata_path.write_text(artifact.to_json())
    return TrainResult(model=model, artifact=artifact, weights_path=weights_path, metadata_path=metadata_path)


def standardize(train: np.ndarray, *others: np.ndarray) -> tuple[np.ndarray, ...]:
    mu = train.mean(axis=0)
    sd = train.std(axis=0) + 1e-6
    out = [((train - mu) / sd).astype(np.float32)]
    for o in others:
        out.append(((o - mu) / sd).astype(np.float32))
    return (*out, mu.astype(np.float32), sd.astype(np.float32))


def write_run_manifest(weights_dir: Path, manifest: dict) -> Path:
    path = Path(weights_dir) / "TRAINING_RUN_MANIFEST.json"
    existing = []
    if path.exists():
        existing = json.loads(path.read_text())
    existing.append(manifest)
    path.write_text(json.dumps(existing, indent=2, sort_keys=True))
    return path
