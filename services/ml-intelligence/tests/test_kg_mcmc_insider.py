"""Tests for the KG/MCMC/insider-threat/robustness additions (2026-09-25)."""
from __future__ import annotations

import numpy as np
import pytest
import torch

from umojaflowos_ml import adversarial, bayesian, insider, kgqa, kg_pipeline, synthetic_insider
from umojaflowos_ml.falkordb_export import facts_to_cypher, graph_facts


# ----------------------------- MCMC / Bayesian -----------------------------

def test_mcmc_recovers_separable_signal():
    rng = np.random.default_rng(0)
    x = rng.normal(size=(400, 2))
    beta_true = np.array([2.5, -1.5])
    p = 1 / (1 + np.exp(-(x @ beta_true + 0.5)))
    y = (rng.random(400) < p).astype(float)
    res = bayesian.metropolis_hastings_logistic(x, y, draws=2000, burn_in=800, seed=1)
    # Posterior mean recovers sign and rough magnitude of the true coefficients.
    assert res.mean[0] > 1.0 and res.mean[1] < -0.5
    assert 0.1 < res.acceptance_rate < 0.9
    mean, lo, hi = res.posterior_predictive(np.array([[2.0, -2.0], [-2.0, 2.0]]))
    assert mean[0] > 0.8 and mean[1] < 0.2
    assert (lo <= mean).all() and (mean <= hi).all()
    # Uncertainty is expressed: credible intervals have nonzero width.
    assert (hi - lo > 0).all()


def test_mcmc_samples_roundtrip(tmp_path):
    rng = np.random.default_rng(2)
    x = rng.normal(size=(120, 1))
    y = (x[:, 0] > 0).astype(float)
    res = bayesian.metropolis_hastings_logistic(x, y, draws=500, burn_in=200, seed=3)
    path = res.save(tmp_path / "posterior.npz")
    loaded = bayesian.MCMCSampleSet.load(path)
    assert loaded.samples.shape == res.samples.shape
    assert loaded.acceptance_rate == pytest.approx(res.acceptance_rate)


# ----------------------------- Insider threat -------------------------------

@pytest.fixture(scope="module")
def insider_data():
    return synthetic_insider.generate_insider_scenarios(seed=7)


def test_sod_violations_detected(insider_data):
    signals = insider.mine_sod_violations(insider_data["audit"])
    assert any(s.kind == "sod_violation" for s in signals)
    # Each planted self-approver is flagged.
    flagged = {s.subject for s in signals}
    assert len(flagged & set(insider_data["insider_subjects"])) >= 1


def test_collusion_ring_detected(insider_data):
    audit = insider_data["audit"]
    actions = audit[["actor", "object_id"]]
    signals = insider.detect_collusion_communities(actions)
    assert any(s.kind == "collusion" for s in signals)


def test_time_abuse_detected(insider_data):
    signals = insider.detect_time_abuse(insider_data["audit"], min_burst=5)
    assert any(s.kind == "time_abuse" for s in signals)


def test_embezzlement_patterns_detected(insider_data):
    signals = insider.detect_embezzlement_patterns(insider_data["txns"], approval_threshold=insider_data["approval_threshold"])
    kinds = {s.subject for s in signals}
    assert "NGACC-STR-1" in kinds          # structuring
    assert "NGACC-EMB-1" in kinds          # round trips
    assert "NGACC-DORM-1" in kinds         # dormant drain


def test_fusion_separates_insiders_from_benign(insider_data):
    audit, txns = insider_data["audit"], insider_data["txns"]
    signals = (
        insider.mine_sod_violations(audit)
        + insider.detect_collusion_communities(audit[["actor", "object_id"]])
        + insider.detect_time_abuse(audit)
        + insider.detect_embezzlement_patterns(txns, approval_threshold=insider_data["approval_threshold"])
    )
    x, y = insider_data["fusion_x"], insider_data["fusion_y"]
    assessments = insider.fuse_insider_risk(
        signals,
        embedding_anomaly={s: 0.9 for s in insider_data["insider_subjects"]},
        training_rows=(x, y),
        seed=11,
    )
    insider_scores = {a.subject: a.posterior_mean for a in assessments}
    planted = [s for s in insider_data["insider_subjects"] if s in insider_scores]
    assert planted, "planted insiders must appear in the fused assessment"
    assert np.mean([insider_scores[s] for s in planted]) > 0.5
    for a in assessments:
        assert a.ci_lower <= a.posterior_mean <= a.ci_upper
        assert a.band in {"baseline", "elevated", "high", "critical"}


def test_fusion_refuses_to_fabricate_posterior():
    with pytest.raises(ValueError):
        insider.fuse_insider_risk([], {}, mcmc=None, training_rows=None)


# ----------------------------- KGQA (EPR) ------------------------------------

def _sample_facts():
    return [
        kgqa.Fact("cp_1", "registered_as", "licensed_psp"),
        kgqa.Fact("cp_1", "domiciled_in", "Nigeria"),
        kgqa.Fact("int_1", "connects_counterparty", "cp_1"),
        kgqa.Fact("int_1", "provides_capability", "payment_rail"),
        kgqa.Fact("int_1", "has_state", "active"),
    ]


def test_epr_index_retrieves_relevant_subgraph():
    idx = kgqa.EvidencePatternIndex()
    idx.add_facts(_sample_facts())
    best = idx.evidence_subgraph("which capability does int_1 provides_capability")
    assert best.facts, "evidence subgraph must not be empty for a matching question"
    assert all(f.relation in {p.relation for p in best.patterns} for f in best.facts)
    assert best.score > 0


def test_epr_empty_index_is_honest():
    idx = kgqa.EvidencePatternIndex()
    best = idx.evidence_subgraph("anything")
    assert best.facts == [] and best.score == 0.0


def test_pattern_scorer_forward():
    scorer = kgqa.PatternScorer()
    q = torch.zeros(kgqa.EMB_DIM)
    p = torch.ones(kgqa.EMB_DIM)
    out = scorer(q, p)
    assert out.ndim == 0


# --------------------------- CocoIndex flows ---------------------------------

def test_kg_flows_are_incremental(tmp_path):
    cps = [{"id": "cp_1", "counterpartyType": "licensed_psp", "jurisdiction": "Nigeria", "legalName": "Lagos PSP Ltd"}]
    ints = [{"id": "int_1", "counterpartyId": "cp_1", "category": "payment_rail", "state": "active"}]
    audit = [{"actor": "op_001", "action": "payment_order.create", "object_id": "po_1", "ts": "2026-09-01T10:00:00Z"}]
    first = kg_pipeline.run_kg_flows(tmp_path, cps, ints, audit)
    assert sum(r.changed_sources for r in first) == 3
    second = kg_pipeline.run_kg_flows(tmp_path, cps, ints, audit)
    assert sum(r.changed_sources for r in second) == 0, "unchanged sources must not be reprocessed"
    cps[0]["jurisdiction"] = "Kenya"
    third = kg_pipeline.run_kg_flows(tmp_path, cps, ints, audit)
    assert third[0].changed_sources == 1, "only the changed row is reprocessed"


def test_ollama_advisory_contract_on_unreachable_server():
    with pytest.raises(RuntimeError):
        kg_pipeline.ollama_advisory_narration(
            [kgqa.Fact("a", "r", "b")], "q", base_url="http://127.0.0.1:9", timeout_s=1.0
        )


# ------------------------------- FalkorDB ------------------------------------

def test_falkordb_cypher_is_idempotent_merge():
    lines = facts_to_cypher([kgqa.Fact("a", "sent_to", "b")])
    assert lines[0].startswith("// UmojaFlowOS")
    assert "MERGE" in lines[1] and "SENT_TO" in lines[1]


# --------------------------- Adversarial (ART) --------------------------------

class _TinyFraudNet(torch.nn.Module):
    def __init__(self, d=4):
        super().__init__()
        self.fc = torch.nn.Linear(d, 1)

    def forward(self, x):
        return self.fc(x)


def test_evasion_evaluation_structure():
    torch.manual_seed(0)
    model = _TinyFraudNet()
    rng = np.random.default_rng(5)
    x = rng.normal(size=(80, 4)).astype(np.float32)
    y = (x[:, 0] > 0).astype(float)
    report = adversarial.evaluate_evasion(model, x, y, epsilons=(0.05,))
    assert set(report.attacks) == {"fgsm", "pgd"}
    assert 0.0 <= report.worst_recall <= 1.0
    assert report.clean_fraud_recall >= report.worst_recall - 1e-9


def test_poisoning_suspects_flag_extreme_minority_rows():
    rng = np.random.default_rng(6)
    x = rng.normal(size=(200, 3))
    y = np.zeros(200)
    x[199] = 30.0  # extreme leverage row
    y[199] = 1     # in the minority class
    report = adversarial.poisoning_suspect_report(x, y, influence_threshold=3.0)
    assert 199 in report["suspect_rows"]
    assert report["minority_class"] == 1
