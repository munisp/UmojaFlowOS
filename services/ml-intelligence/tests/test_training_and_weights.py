"""Training loops must produce real weights, real metrics, verified artifacts."""
from __future__ import annotations

import json

import torch

from umojaflowos_ml.features import CATEGORICAL_FEATURES, NUMERIC_FEATURES
from umojaflowos_ml.models import CreditNet, FraudAutoencoder, FraudNet, MuleGraphSAGE
from umojaflowos_ml.schemas import TrainedArtifact, sha256_of
from umojaflowos_ml.training import (train_autoencoder_model, train_credit_model,
                                     train_fraud_model, train_gnn_model)


def test_fraud_training_loop_produces_verified_weights(small_corpus, tmp_path):
    txns, accounts = small_corpus
    kyc = dict(zip(accounts["account_id"], accounts["kyc_tier"]))
    res = train_fraud_model(txns, tmp_path, "t1", kyc, epochs=3, batch_size=2048)
    assert res.weights_path.exists() and res.metadata_path.exists()
    assert res.weights_path.stat().st_size > 10_000  # real network, not empty
    artifact = TrainedArtifact.from_json(res.metadata_path.read_text())
    assert artifact.weights_sha256 == sha256_of(res.weights_path.read_bytes())
    assert artifact.epochs_run >= 1
    assert artifact.n_train > 0 and artifact.n_val > 0
    # model must beat chance on PR-AUC (labels carry learnable signal)
    assert artifact.metrics["pr_auc"] > artifact.metrics["positive_rate"] * 1.5
    # weights actually load into the architecture
    model = FraudNet(n_numeric=len(NUMERIC_FEATURES),
                     vocab_sizes={c: len(artifact.feature_config["vocab"][c]) for c in CATEGORICAL_FEATURES})
    model.load_state_dict(torch.load(res.weights_path, map_location="cpu", weights_only=True))


def test_credit_training_loop_multitask(small_corpus, tmp_path):
    txns, accounts = small_corpus
    res = train_credit_model(txns, accounts, tmp_path, "t1", epochs=3)
    assert 0.0 <= res.artifact.metrics["roc_auc"] <= 1.0
    assert 0.0 <= res.artifact.metrics["band_accuracy"] <= 1.0
    model = CreditNet(n_features=len(res.artifact.feature_config["numeric"]))
    model.load_state_dict(torch.load(res.weights_path, map_location="cpu", weights_only=True))


def test_gnn_training_loop_on_graph(small_corpus, tmp_path):
    txns, accounts = small_corpus
    labels = dict(zip(accounts["account_id"], accounts["is_mule"]))
    kyc = dict(zip(accounts["account_id"], accounts["kyc_tier"]))
    res = train_gnn_model(txns, labels, tmp_path, "t1", kyc, epochs=10)
    assert res.artifact.metrics["roc_auc"] > 0.5   # better than chance
    assert res.artifact.feature_config["num_nodes"] > 0
    assert res.artifact.feature_config["num_edges"] > 0
    model = MuleGraphSAGE(n_node_features=len(res.artifact.feature_config["node_features"]))
    model.load_state_dict(torch.load(res.weights_path, map_location="cpu", weights_only=True))


def test_autoencoder_separates_fraud_from_legit(small_corpus, tmp_path):
    txns, accounts = small_corpus
    kyc = dict(zip(accounts["account_id"], accounts["kyc_tier"]))
    res = train_autoencoder_model(txns, tmp_path, "t1", kyc, epochs=3)
    assert res.artifact.metrics["roc_auc"] > 0.5
    assert 0.0 <= res.artifact.metrics["fraud_catch_rate_at_threshold"] <= 1.0
    model = FraudAutoencoder(n_numeric=len(NUMERIC_FEATURES),
                             vocab_sizes={c: len(res.artifact.feature_config["vocab"][c]) for c in CATEGORICAL_FEATURES})
    model.load_state_dict(torch.load(res.weights_path, map_location="cpu", weights_only=True))


def test_not_rule_based_scores_vary_smoothly(small_corpus, tmp_path):
    """A rule engine would produce a handful of discrete outputs; a trained
    network must produce a continuous score distribution."""
    txns, accounts = small_corpus
    kyc = dict(zip(accounts["account_id"], accounts["kyc_tier"]))
    res = train_fraud_model(txns, tmp_path, "t2", kyc, epochs=2, batch_size=2048)
    from umojaflowos_ml.features import build_feature_frame
    from umojaflowos_ml.inference import score_fraud_frame
    from umojaflowos_ml.registry import ModelRegistry
    registry = ModelRegistry(tmp_path / "reg")
    reg = registry.register(res.artifact, res.weights_path)
    frame = build_feature_frame(txns.sample(2000, random_state=1), kyc)
    scores = score_fraud_frame(reg, frame)
    assert len(set(scores.round(6).tolist())) > 500   # continuous, not rule buckets
    assert scores.min() >= 0.0 and scores.max() <= 1.0
