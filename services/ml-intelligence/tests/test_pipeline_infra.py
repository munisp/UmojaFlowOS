"""Lakehouse, registry, A/B, monitoring, continuous cycle, Neo4j export, CPU serving."""
from __future__ import annotations

import json

import numpy as np
import pytest

from umojaflowos_ml.ab_testing import (ABExperimentStore, Experiment,
                                       evaluate_experiment, route_assignment)
from umojaflowos_ml.lakehouse import run_synthetic_pipeline
from umojaflowos_ml.monitoring import (detect_drift, drift_alerts,
                                       performance_alerts)
from umojaflowos_ml.neo4j_export import graph_to_cypher_file
from umojaflowos_ml.graph_builder import build_graph
from umojaflowos_ml.registry import ModelRegistry


def test_lakehouse_bronze_silver_gold(tmp_path):
    snapshot, txns, accounts = run_synthetic_pipeline(
        tmp_path / "lh", n_accounts=300, n_txns=4000, day="2026-02-01", seed=11)
    assert snapshot.n_transactions > 0
    assert (snapshot.bronze_path / "transactions.parquet").exists()
    assert (snapshot.silver_path / "transactions.parquet").exists()
    assert (snapshot.gold_path / "fraud_features.parquet").exists()
    assert (snapshot.gold_path / "credit_features.parquet").exists()
    assert (snapshot.gold_path / "graph_snapshot.npz").exists()
    # silver dedupes on txn_id
    import pandas as pd
    silver = pd.read_parquet(snapshot.silver_path / "transactions.parquet")
    assert silver["txn_id"].is_unique


def test_registry_versioning_and_promotion(tmp_path, small_corpus):
    from umojaflowos_ml.training import train_fraud_model
    txns, accounts = small_corpus
    kyc = dict(zip(accounts["account_id"], accounts["kyc_tier"]))
    registry = ModelRegistry(tmp_path / "reg")
    r1 = train_fraud_model(txns, tmp_path / "w", "vA", kyc, epochs=2, batch_size=4096)
    registry.register(r1.artifact, r1.weights_path, stage="production")
    r2 = train_fraud_model(txns, tmp_path / "w", "vB", kyc, epochs=2, batch_size=4096)
    registry.register(r2.artifact, r2.weights_path, stage="staging")
    assert registry.get("fraud_net", stage="production").version == "vA"
    registry.promote("fraud_net", "vB", "production")
    assert registry.get("fraud_net", stage="production").version == "vB"
    # old champion demoted to staging (single champion invariant)
    assert registry.get("fraud_net", version="vA").stage == "staging"
    assert len(registry.list_versions("fraud_net")) == 2


def test_ab_routing_deterministic_and_evaluation():
    exp = Experiment("e1", "fraud_net", champion_version="v1", challenger_version="v2",
                     challenger_traffic_pct=20.0, min_samples=10)
    assert route_assignment(exp, "acct-1") == route_assignment(exp, "acct-1")
    arms = {route_assignment(exp, f"acct-{i}") for i in range(200)}
    assert arms == {"champion", "challenger"}
    rng = np.random.default_rng(0)
    y = rng.integers(0, 2, 100)
    champ = rng.random(100) * 0.5
    chall = y * 0.5 + rng.random(100) * 0.5
    out = evaluate_experiment(exp, y, champ, chall, promotion_margin=0.01)
    assert out["decided"] and out["decision"] == "promote_challenger"


def test_drift_detection_and_performance_alerts():
    rng = np.random.default_rng(0)
    base = {"amount": rng.normal(0, 1, 5000)}
    shifted = {"amount": rng.normal(2.0, 1, 5000)}
    reports = detect_drift(base, shifted)
    assert reports[0].drifted and reports[0].psi > 0.25
    alerts = drift_alerts("fraud_net", reports)
    assert any(a.severity == "critical" for a in alerts)
    perf = performance_alerts("fraud_net", {"pr_auc": 0.80}, {"pr_auc": 0.70})
    assert perf and perf[0].alert == "model_performance_degradation"


def test_neo4j_cypher_export(small_corpus, tmp_path):
    txns, accounts = small_corpus
    labels = dict(zip(accounts["account_id"], accounts["is_mule"]))
    graph = build_graph(txns, labels)
    path = graph_to_cypher_file(graph, None, tmp_path / "graph.cypher")
    text = path.read_text()
    assert "MERGE (a:Account" in text and "SENT_TO" in text
    assert text.count("MERGE (a:Account") >= graph.num_nodes


def test_cpu_inference_service(tmp_path, small_corpus):
    from fastapi.testclient import TestClient
    from umojaflowos_ml.inference import create_app
    from umojaflowos_ml.training import train_fraud_model
    txns, accounts = small_corpus
    kyc = dict(zip(accounts["account_id"], accounts["kyc_tier"]))
    registry = ModelRegistry(tmp_path / "reg")
    res = train_fraud_model(txns, tmp_path / "w", "v1", kyc, epochs=2, batch_size=4096)
    registry.register(res.artifact, res.weights_path, stage="production")
    client = TestClient(create_app(tmp_path / "reg"))
    assert client.get("/healthz").json()["device"] == "cpu"
    from umojaflowos_ml.features import NUMERIC_FEATURES
    payload = {"features": {c: 0.0 for c in NUMERIC_FEATURES}}
    r = client.post("/v1/score/fraud", json=payload)
    assert r.status_code == 200
    body = r.json()
    assert 0.0 <= body["fraud_score"] <= 1.0
    assert body["advisory_only"] is True and body["review_required"] is True
    # missing features rejected
    r2 = client.post("/v1/score/fraud", json={"features": {}})
    assert r2.status_code == 422


def test_continuous_cycle_first_run_promotes(tmp_path):
    from umojaflowos_ml.continuous import run_continuous_cycle
    report = run_continuous_cycle(
        tmp_path, n_accounts=400, n_txns=8000, seed=5,
        epochs_fraud=2, epochs_credit=2, epochs_gnn=8, epochs_ae=2)
    assert report.ab_decision == "initial_promotion"
    assert set(report.versions) == {"fraud_net", "credit_net", "mule_graphsage", "fraud_autoencoder"}
    history = json.loads((tmp_path / "monitoring" / "cycle_history.json").read_text())
    assert history[-1]["cycle_id"] == report.cycle_id
    assert (tmp_path / "monitoring" / "baseline_drift.json").exists()


def test_lakehouse_from_env_wiring(tmp_path, monkeypatch):
    """The governed infra/lakehouse boundary wires to the ML pipeline via env."""
    from umojaflowos_ml.lakehouse import MLLakehouse

    monkeypatch.setenv("UMOJA_LAKEHOUSE_ROOT", str(tmp_path / "lh"))
    monkeypatch.delenv("UMOJA_LAKEHOUSE_ENABLED", raising=False)
    lh = MLLakehouse.from_env()
    assert lh.root == tmp_path / "lh"
    assert (tmp_path / "lh" / "bronze").is_dir()

    monkeypatch.setenv("UMOJA_LAKEHOUSE_ENABLED", "false")
    with pytest.raises(RuntimeError, match="disabled"):
        MLLakehouse.from_env()
