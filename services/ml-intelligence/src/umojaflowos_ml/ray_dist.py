"""Ray-based distributed compute for the ML stack.

Provides:
  * parallel synthetic data generation across Ray workers
  * distributed hyperparameter search for FraudNet (data-parallel trials)
  * graceful local fallback when Ray is not installed / cluster is absent,
    so CI and CPU-only laptops still run the full pipeline.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


def _ray():
    try:
        import ray  # optional dependency
        return ray
    except ImportError:
        return None


def init_ray(address: str | None = None, num_cpus: int | None = None) -> bool:
    ray = _ray()
    if ray is None:
        return False
    if not ray.is_initialized():
        ray.init(address=address, num_cpus=num_cpus, ignore_reinit_error=True,
                 include_dashboard=False, log_to_driver=False)
    return True


def parallel_generate(n_accounts: int, total_txns: int, n_shards: int = 4, seed: int = 42) -> pd.DataFrame:
    """Generate a large corpus in parallel shards; deterministic union."""
    ray = _ray()
    from .synthetic_nigeria import NigerianPaymentsGenerator

    def make_shard(s: int, k: int) -> pd.DataFrame:
        g = NigerianPaymentsGenerator(seed=seed + s)
        accounts = g.generate_accounts(max(500, n_accounts // n_shards))
        return g.generate_transactions(accounts, k)

    shard_txns = total_txns // n_shards
    if ray is not None and init_ray():
        remote = ray.remote(make_shard)
        parts = ray.get([remote.remote(s, shard_txns) for s in range(n_shards)])
    else:
        parts = [make_shard(s, shard_txns) for s in range(n_shards)]
    return pd.concat(parts, ignore_index=True)


@dataclass
class TrialResult:
    params: dict[str, Any]
    pr_auc: float
    roc_auc: float


def distributed_hparam_search(
    txns: pd.DataFrame,
    weights_dir: Path | str,
    trials: list[dict[str, Any]] | None = None,
    seed: int = 42,
) -> list[TrialResult]:
    """Small data-parallel hyperparameter sweep for FraudNet."""
    from .training.train_fraud import train_fraud_model

    trials = trials or [
        {"lr": 2e-3, "epochs": 15, "batch_size": 1024},
        {"lr": 5e-3, "epochs": 15, "batch_size": 2048},
        {"lr": 1e-3, "epochs": 20, "batch_size": 512},
    ]
    ray = _ray()

    def run_trial(t: dict[str, Any], idx: int) -> TrialResult:
        sub = Path(weights_dir) / f"hparam-trial-{idx}"
        res = train_fraud_model(txns, sub, version=f"trial{idx}", seed=seed + idx, **t)
        return TrialResult(params=t, pr_auc=res.artifact.metrics["pr_auc"], roc_auc=res.artifact.metrics["roc_auc"])

    if ray is not None and init_ray():
        txns_ref = ray.put(txns)
        remote = ray.remote(run_trial)
        results = ray.get([remote.remote(t, i) for i, t in enumerate(trials)])
    else:
        results = [run_trial(t, i) for i, t in enumerate(trials)]
    return sorted(results, key=lambda r: r.pr_auc, reverse=True)
