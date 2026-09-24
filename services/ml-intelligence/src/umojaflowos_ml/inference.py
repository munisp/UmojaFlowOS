"""CPU inference for all four models.

Loads registered weights + feature config from the ModelRegistry and scores
with plain PyTorch on CPU (torch.set_num_threads honours OMP_NUM_THREADS).
No GPU is required anywhere in training or serving.

Consistent with the platform's control boundary, every response carries
``advisory_only: true`` and ``review_required: true``: scores are risk
evidence for human reviewers, never an automated payment/credit decision.
"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from .features import (CATEGORICAL_FEATURES, CREDIT_FEATURES, NUMERIC_FEATURES,
                       encode_categoricals)
from .models import CreditNet, FraudAutoencoder, FraudNet, MuleGraphSAGE
from .registry import ModelRegistry, RegisteredModel

torch.set_num_threads(max(1, int(os.environ.get("OMP_NUM_THREADS", "4"))))


class LoadedFraudModel:
    def __init__(self, registered: RegisteredModel):
        cfg = registered.artifact.feature_config
        vocab_sizes = {c: len(cfg["vocab"][c]) for c in CATEGORICAL_FEATURES}
        self.model = FraudNet(n_numeric=len(NUMERIC_FEATURES), vocab_sizes=vocab_sizes)
        self.model.load_state_dict(torch.load(registered.weights_path, map_location="cpu", weights_only=True))
        self.model.eval()
        self.mu = np.array(cfg["norm_mean"], dtype=np.float32)
        self.sd = np.array(cfg["norm_std"], dtype=np.float32)
        self.meta = registered

    def score_frame(self, frame: pd.DataFrame) -> np.ndarray:
        x = ((frame[NUMERIC_FEATURES].to_numpy().astype(np.float32) - self.mu) / self.sd).astype(np.float32)
        cats = encode_categoricals(frame)
        with torch.no_grad():
            return self.model.predict_proba(
                torch.from_numpy(x), {k: torch.from_numpy(v) for k, v in cats.items()}
            ).numpy()


class LoadedCreditModel:
    def __init__(self, registered: RegisteredModel):
        cfg = registered.artifact.feature_config
        self.model = CreditNet(n_features=len(CREDIT_FEATURES))
        self.model.load_state_dict(torch.load(registered.weights_path, map_location="cpu", weights_only=True))
        self.model.eval()
        self.mu = np.array(cfg["norm_mean"], dtype=np.float32)
        self.sd = np.array(cfg["norm_std"], dtype=np.float32)
        self.meta = registered

    def score(self, features: dict[str, float]) -> dict:
        x = np.array([[features.get(c, 0.0) for c in CREDIT_FEATURES]], dtype=np.float32)
        x = ((x - self.mu) / self.sd).astype(np.float32)
        with torch.no_grad():
            pd_prob, band = self.model.score(torch.from_numpy(x))
        return {"probability_of_default": float(pd_prob[0]), "band": "ABCDE"[int(band[0])]}


class LoadedGNNModel:
    def __init__(self, registered: RegisteredModel):
        self.model = MuleGraphSAGE(n_node_features=len(registered.artifact.feature_config["node_features"]))
        self.model.load_state_dict(torch.load(registered.weights_path, map_location="cpu", weights_only=True))
        self.model.eval()
        self.meta = registered

    def score_graph(self, x: np.ndarray, edge_index: np.ndarray) -> np.ndarray:
        with torch.no_grad():
            return self.model.predict_proba(
                torch.from_numpy(x.astype(np.float32)),
                torch.from_numpy(edge_index.astype(np.int64)),
            ).numpy()


class LoadedAutoencoderModel:
    def __init__(self, registered: RegisteredModel):
        cfg = registered.artifact.feature_config
        vocab_sizes = {c: len(cfg["vocab"][c]) for c in CATEGORICAL_FEATURES}
        self.model = FraudAutoencoder(n_numeric=len(NUMERIC_FEATURES), vocab_sizes=vocab_sizes)
        self.model.load_state_dict(torch.load(registered.weights_path, map_location="cpu", weights_only=True))
        self.model.eval()
        self.mu = np.array(cfg["norm_mean"], dtype=np.float32)
        self.sd = np.array(cfg["norm_std"], dtype=np.float32)
        self.threshold = float(cfg["anomaly_threshold"])
        self.meta = registered

    def score_frame(self, frame: pd.DataFrame) -> np.ndarray:
        x = ((frame[NUMERIC_FEATURES].to_numpy().astype(np.float32) - self.mu) / self.sd).astype(np.float32)
        cats = encode_categoricals(frame)
        with torch.no_grad():
            return self.model.anomaly_score(
                torch.from_numpy(x), {k: torch.from_numpy(v) for k, v in cats.items()}
            ).numpy()


def score_fraud_frame(registered: RegisteredModel, frame: pd.DataFrame) -> np.ndarray:
    return LoadedFraudModel(registered).score_frame(frame)


# ------------------------------------------------------------- request models
# Defined at module level so FastAPI can resolve annotations under
# `from __future__ import annotations`.
from pydantic import BaseModel  # noqa: E402


class TxnScoreRequest(BaseModel):
    features: dict[str, float]
    channel: str = "nip_instant"
    txn_type: str = "p2p"
    src_bank: str = "OTHER"
    ip_country: str = "NG"


# ---------------------------------------------------------------- FastAPI app
def create_app(registry_root: Path | str, mlflow_tracking_uri: str | None = None):
    from fastapi import FastAPI, HTTPException

    registry = ModelRegistry(registry_root, mlflow_tracking_uri=mlflow_tracking_uri)
    app = FastAPI(title="UmojaFlowOS ML Intelligence", version="1.0.0")
    cache: dict[str, object] = {}

    def load(family: str, loader):
        if family not in cache:
            try:
                cache[family] = loader(registry.get(family, stage="production"))
            except KeyError:
                cache[family] = loader(registry.get(family))  # fall back to latest
        return cache[family]

    @app.get("/healthz")
    def healthz():
        return {"status": "ok", "device": "cpu", "advisory_only": True}

    @app.get("/v1/models")
    def list_models():
        out = {}
        for family in ("fraud_net", "credit_net", "mule_graphsage", "fraud_autoencoder"):
            try:
                out[family] = registry.list_versions(family)
            except Exception:
                out[family] = []
        return out

    @app.post("/v1/score/fraud")
    def score_fraud(req: TxnScoreRequest):
        model: LoadedFraudModel = load("fraud_net", LoadedFraudModel)
        missing = [c for c in NUMERIC_FEATURES if c not in req.features]
        if missing:
            raise HTTPException(422, f"missing features: {missing}")
        frame = pd.DataFrame([{**req.features, "channel": req.channel, "txn_type": req.txn_type,
                               "src_bank": req.src_bank, "ip_country": req.ip_country}])
        score = float(model.score_frame(frame)[0])
        return {
            "fraud_score": score,
            "model": model.meta.artifact.model_name,
            "version": model.meta.version,
            "weights_sha256": model.meta.artifact.weights_sha256,
            "advisory_only": True,
            "review_required": True,
            "decision_authority": "none — human compliance review only",
        }

    @app.post("/v1/score/credit")
    def score_credit(features: dict[str, float]):
        model: LoadedCreditModel = load("credit_net", LoadedCreditModel)
        result = model.score(features)
        return {**result, "model": model.meta.artifact.model_name, "version": model.meta.version,
                "advisory_only": True, "review_required": True}

    @app.post("/v1/score/anomaly")
    def score_anomaly(req: TxnScoreRequest):
        model: LoadedAutoencoderModel = load("fraud_autoencoder", LoadedAutoencoderModel)
        frame = pd.DataFrame([{**req.features, "channel": req.channel, "txn_type": req.txn_type,
                               "src_bank": req.src_bank, "ip_country": req.ip_country}])
        score = float(model.score_frame(frame)[0])
        return {"anomaly_score": score, "threshold": model.threshold,
                "anomalous": score >= model.threshold, "model": model.meta.artifact.model_name,
                "version": model.meta.version, "advisory_only": True, "review_required": True}

    return app
