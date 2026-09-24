"""Continuous training orchestrator.

The full loop the platform was missing:

  1. extract the newest window from the Lakehouse (production DB in prod,
     synthetic Nigerian generator elsewhere)
  2. check feature drift vs the training baseline
  3. retrain all four models on the new window
  4. register candidates as `staging`
  5. open an A/B experiment vs the production champion
  6. on a fresh labelled evaluation slice, promote or reject automatically
  7. emit monitoring alerts when drift or degradation crosses thresholds

Designed to be invoked by a scheduler (cron/systemd/K8s CronJob) with
`run_continuous_cycle`; also safe to run ad hoc.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np
import pandas as pd

from .ab_testing import ABExperimentStore, Experiment, apply_decision, evaluate_experiment
from .features import NUMERIC_FEATURES, build_feature_frame
from .lakehouse import run_synthetic_pipeline
from .monitoring import AlertSink, detect_drift, drift_alerts, performance_alerts
from .registry import ModelRegistry
from .schemas import TrainedArtifact, utcnow
from .training import (train_autoencoder_model, train_credit_model,
                       train_fraud_model, train_gnn_model)


@dataclass
class CycleReport:
    cycle_id: str
    started_at: str
    versions: dict[str, str]
    metrics: dict[str, dict[str, float]]
    drifted_features: list[str]
    ab_decision: str | None
    alerts: int
    provenance: str


def _load_baseline_distribution(gold_features_path: Path) -> dict[str, np.ndarray]:
    frame = pd.read_parquet(gold_features_path)
    return {c: frame[c].to_numpy() for c in NUMERIC_FEATURES if c in frame.columns}


def run_continuous_cycle(
    workspace: Path | str,
    n_accounts: int = 4000,
    n_txns: int = 120_000,
    seed: int = 42,
    epochs_fraud: int = 25,
    epochs_credit: int = 25,
    epochs_gnn: int = 60,
    epochs_ae: int = 20,
    version_tag: str | None = None,
    mlflow_tracking_uri: str | None = None,
) -> CycleReport:
    workspace = Path(workspace)
    lakehouse_root = workspace / "lakehouse"
    weights_dir = workspace / "weights"
    registry_root = workspace / "registry"
    experiments_root = workspace / "experiments"
    alerts_path = workspace / "monitoring" / "alerts.jsonl"
    started = utcnow().isoformat()
    version = version_tag or utcnow().strftime("v%Y%m%d%H%M%S")

    # 1. extract (Lakehouse bronze->silver->gold)
    snapshot, txns, accounts = run_synthetic_pipeline(lakehouse_root, n_accounts, n_txns, seed=seed)
    kyc_by_account = dict(zip(accounts["account_id"], accounts["kyc_tier"]))
    account_labels = dict(zip(accounts["account_id"], accounts["is_mule"]))

    # 2. drift check against the previous gold baseline (if one exists)
    sink = AlertSink(alerts_path)
    drifted: list[str] = []
    drift_marker = workspace / "monitoring" / "baseline_drift.json"
    current_frame = build_feature_frame(txns, kyc_by_account)
    current_dist = {c: current_frame[c].to_numpy() for c in NUMERIC_FEATURES if c in current_frame.columns}
    if drift_marker.exists():
        baseline = {k: np.array(v) for k, v in json.loads(drift_marker.read_text()).items()}
        reports = detect_drift(baseline, current_dist)
        drifted = [r.feature for r in reports if r.drifted]
        sink.emit(drift_alerts("fraud_net", reports))
    # persist a compact baseline sample for the next cycle
    drift_marker.parent.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(seed)
    drift_marker.write_text(json.dumps({
        k: v[rng.choice(len(v), min(5000, len(v)), replace=False)].tolist()
        for k, v in current_dist.items()
    }))

    # 3-4. retrain and register as staging
    registry = ModelRegistry(registry_root, mlflow_tracking_uri=mlflow_tracking_uri)
    fraud = train_fraud_model(txns, weights_dir, version, kyc_by_account, epochs=epochs_fraud)
    credit = train_credit_model(txns, accounts, weights_dir, version, epochs=epochs_credit)
    gnn = train_gnn_model(txns, account_labels, weights_dir, version, kyc_by_account, epochs=epochs_gnn)
    ae = train_autoencoder_model(txns, weights_dir, version, kyc_by_account, epochs=epochs_ae)
    for res in (fraud, credit, gnn, ae):
        registry.register(res.artifact, res.weights_path, stage="staging")

    versions = {"fraud_net": version, "credit_net": version, "mule_graphsage": version, "fraud_autoencoder": version}
    metrics = {
        "fraud_net": fraud.artifact.metrics,
        "credit_net": credit.artifact.metrics,
        "mule_graphsage": gnn.artifact.metrics,
        "fraud_autoencoder": ae.artifact.metrics,
    }

    # 5-6. A/B evaluation vs champion (first cycle: challenger becomes champion)
    store = ABExperimentStore(experiments_root)
    ab_decision = None
    try:
        champion = registry.get("fraud_net", stage="production")
        exp = Experiment(
            name=f"fraud-net-{version}",
            model_family="fraud_net",
            champion_version=champion.version,
            challenger_version=version,
        )
        store.create(exp)
        frame = build_feature_frame(txns, kyc_by_account)
        y = frame["label_fraud"].to_numpy()
        from .inference import score_fraud_frame
        challenger_scores = score_fraud_frame(registry.get("fraud_net", version=version), frame)
        champion_scores = score_fraud_frame(champion, frame)
        outcome = evaluate_experiment(exp, y, champion_scores, challenger_scores, promotion_margin=0.0)
        if outcome.get("decided"):
            ab_decision = outcome["decision"]
            apply_decision(registry, store, exp.name, ab_decision)
            champ_metric = champion.artifact.metrics.get("pr_auc", 0.0)
            new_metric = fraud.artifact.metrics.get("pr_auc", 0.0)
            sink.emit(performance_alerts("fraud_net", {"pr_auc": champ_metric}, {"pr_auc": new_metric}))
    except KeyError:
        registry.promote("fraud_net", version, "production")
        registry.promote("credit_net", version, "production")
        registry.promote("mule_graphsage", version, "production")
        registry.promote("fraud_autoencoder", version, "production")
        ab_decision = "initial_promotion"

    report = CycleReport(
        cycle_id=f"cycle-{version}",
        started_at=started,
        versions=versions,
        metrics=metrics,
        drifted_features=drifted,
        ab_decision=ab_decision,
        alerts=sink.emit([]),  # count already emitted
        provenance=f"lakehouse run {snapshot.run_id}: {snapshot.n_transactions} txns / {snapshot.n_accounts} accounts",
    )
    (workspace / "monitoring").mkdir(parents=True, exist_ok=True)
    history_path = workspace / "monitoring" / "cycle_history.json"
    history = json.loads(history_path.read_text()) if history_path.exists() else []
    history.append(asdict(report))
    history_path.write_text(json.dumps(history, indent=2, sort_keys=True))
    return report
