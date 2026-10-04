"""Insider-threat and fraud-fusion module.

Answers: how does the platform detect and deter insider theft, collusion,
abuse of company property/time, fraud and embezzlement — by process and by
AI/GNN/Bayesian fusion?

Process layer (enforced by the platform, surfaced here as evidence):
* Separation of duties (SoD): the same operator may not originate AND approve
  the same payment order, treasury recommendation, counterparty licence, or
  credential activation. Violations are mined from the immutable audit trail.
* Four-eyes on privileged actions; immutable, attributable activity records.

Detection layer (this module):
* SoD violation mining over audit events.
* Collusion communities: label-propagation over an operator–counterparty–
  beneficiary affinity graph; operators who repeatedly act on the same small
  set of counterparties form suspiciously tight communities.
* Time/property abuse: off-hours bursts and per-operator velocity anomalies
  against that operator's own historical baseline.
* Embezzlement shapes: round-trip value cycles, dormant-account reactivation
  followed by rapid drain, structuring just under approval thresholds.

Fusion layer:
* Each evidence channel contributes a partial score; a Bayesian logistic layer
  (MCMC, see bayesian.py) fuses them with the GNN embedding anomaly
  (Mahalanobis distance of the account/operator embedding to the benign
  centroid) into a posterior insider-risk probability with a credible
  interval. Wide interval = investigate with more data; it is never an
  accusation. All outputs are advisory review evidence only — disposition is
  always a human compliance decision, consistent with the platform boundary.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .bayesian import MCMCSampleSet, metropolis_hastings_logistic

# Privileged action pairs that must never share an operator on one object.
SOD_PAIRS: dict[str, tuple[str, str]] = {
    "payment_order": ("payment_order.create", "payment_order.approve"),
    "treasury": ("treasury_recommendation.propose", "treasury_recommendation.decide"),
    "licence": ("counterparty_authorization.create", "counterparty_authorization.activate"),
    "credential": ("integration_credential.configure", "integration_connection.activate"),
    "report": ("regulatory_report.draft", "regulatory_report.submit"),
}
OFF_HOURS = (0, 5)  # 00:00–05:00 local — Nigerian ops baseline
STRUCTURING_BAND = (0.90, 1.0)  # 90–100% of an approval threshold


@dataclass
class InsiderSignal:
    subject: str               # operator id or account id
    kind: str                  # sod_violation | collusion | time_abuse | embezzlement_pattern
    severity: float            # 0..1 channel score
    evidence: str


@dataclass
class InsiderRiskAssessment:
    subject: str
    posterior_mean: float
    ci_lower: float
    ci_upper: float
    signals: list[InsiderSignal] = field(default_factory=list)

    @property
    def band(self) -> str:
        if self.posterior_mean >= 0.8:
            return "critical"
        if self.posterior_mean >= 0.5:
            return "high"
        if self.posterior_mean >= 0.25:
            return "elevated"
        return "baseline"


def mine_sod_violations(audit: pd.DataFrame) -> list[InsiderSignal]:
    """Audit trail columns: actor, action, object_id, ts."""
    signals: list[InsiderSignal] = []
    for pair_name, (orig, approve) in SOD_PAIRS.items():
        a = audit[audit["action"] == orig][["object_id", "actor"]].rename(columns={"actor": "originator"})
        b = audit[audit["action"] == approve][["object_id", "actor"]].rename(columns={"actor": "approver"})
        merged = a.merge(b, on="object_id")
        bad = merged[merged["originator"] == merged["approver"]]
        for _, row in bad.iterrows():
            signals.append(InsiderSignal(
                subject=row["originator"],
                kind="sod_violation",
                severity=1.0,
                evidence=f"{pair_name}: operator originated and approved object {row['object_id']}",
            ))
    return signals


def _label_propagation(adj: np.ndarray, max_iter: int = 30, seed: int = 42) -> np.ndarray:
    """Synchronous label propagation communities on a symmetric adjacency."""
    rng = np.random.default_rng(seed)
    n = adj.shape[0]
    labels = np.arange(n)
    for _ in range(max_iter):
        order = rng.permutation(n)
        changed = False
        for i in order:
            neigh = np.flatnonzero(adj[i])
            if len(neigh) == 0:
                continue
            counts = np.bincount(labels[neigh], minlength=n)
            best = int(np.argmax(counts + rng.uniform(0, 1e-6, n)))
            if best != labels[i]:
                labels[i] = best
                changed = True
        if not changed:
            break
    return labels


def detect_collusion_communities(
    actions: pd.DataFrame,
    max_community_share: float = 0.8,
    min_actions: int = 3,
    min_cluster: int = 3,
) -> list[InsiderSignal]:
    """Capture analysis on the operator–object incidence graph.

    ``actions`` columns: actor, object_id. An object worked on by at most two
    operators (out of the whole operator population) with at least
    ``min_actions`` actions is *captured*. Captured objects sharing the same
    small operator set form a collusion community; the dominant operator's
    share of its actions is the severity. Exclusivity — not raw co-occurrence
    volume — is the signal: busy operators legitimately touch many objects,
    which would merge everything if we clustered on co-touch counts alone.
    """
    signals: list[InsiderSignal] = []
    if actions.empty:
        return signals
    n_operators = actions["actor"].nunique()
    if n_operators < 3:
        return signals

    clusters: dict[tuple, list[str]] = {}
    for obj, grp in actions.groupby("object_id"):
        if len(grp) < min_actions:
            continue
        actor_set = tuple(sorted(grp["actor"].unique()))
        if len(actor_set) <= 2 and len(actor_set) < n_operators:
            clusters.setdefault(actor_set, []).append(obj)

    for actor_set, objs in clusters.items():
        if len(objs) < min_cluster:
            continue
        sub = actions[actions["object_id"].isin(objs)]
        share = sub["actor"].value_counts(normalize=True)
        top_actor, top_share = share.index[0], float(share.iloc[0])
        if top_share >= max_community_share:
            signals.append(InsiderSignal(
                subject=top_actor,
                kind="collusion",
                severity=min(1.0, top_share),
                evidence=(
                    f"{top_share:.0%} of actions on a captured {len(objs)}-object cluster "
                    f"({len(actor_set)} operator(s) out of {n_operators})"
                ),
            ))
    return signals


def detect_time_abuse(audit: pd.DataFrame, min_burst: int = 5) -> list[InsiderSignal]:
    """Off-hours bursts and velocity spikes vs the operator's own baseline."""
    signals: list[InsiderSignal] = []
    if audit.empty:
        return signals
    a = audit.copy()
    a["dt"] = pd.to_datetime(a["ts"], utc=True)
    a["hour"] = a["dt"].dt.hour
    a["day"] = a["dt"].dt.date
    off = a[(a["hour"] >= OFF_HOURS[0]) & (a["hour"] < OFF_HOURS[1])]
    window_days = max(a["day"].nunique(), 1)
    for (actor, day), grp in off.groupby(["actor", "day"]):
        # Baseline is the operator's own off-hours rate across the whole
        # observation window (zero-activity nights count): a burst at 02:00 is
        # anomalous for someone who never works nights, regardless of how busy
        # their days are.
        baseline = len(off[off["actor"] == actor]) / window_days
        if len(grp) >= min_burst and len(grp) > 3 * max(baseline, 1):
            signals.append(InsiderSignal(
                subject=actor,
                kind="time_abuse",
                severity=min(1.0, len(grp) / (10 * max(baseline, 1))),
                evidence=f"{len(grp)} privileged actions at 00:00–05:00 on {day} vs baseline {baseline:.1f}/day",
            ))
    return signals


def detect_embezzlement_patterns(
    txns: pd.DataFrame,
    approval_threshold: float,
    window_days: int = 7,
) -> list[InsiderSignal]:
    """Round-trip cycles, dormant-reactivation drains, sub-threshold structuring.

    ``txns`` columns: src_account, dst_account, amount_ngn, ts.
    """
    signals: list[InsiderSignal] = []
    if txns.empty:
        return signals
    t = txns.copy()
    t["dt"] = pd.to_datetime(t["ts"], utc=True)

    # Structuring: repeated amounts in the 90–100% band of the approval threshold.
    band = t[(t["amount_ngn"] >= STRUCTURING_BAND[0] * approval_threshold) & (t["amount_ngn"] < approval_threshold)]
    for src, grp in band.groupby("src_account"):
        if len(grp) >= 3:
            signals.append(InsiderSignal(
                subject=src, kind="embezzlement_pattern", severity=min(1.0, len(grp) / 6),
                evidence=f"{len(grp)} transfers between {STRUCTURING_BAND[0]:.0%}–100% of the approval threshold",
            ))

    # Round trips: A→B then B→A within window with similar value.
    fwd = t[["src_account", "dst_account", "amount_ngn", "dt"]]
    rev = fwd.rename(columns={"src_account": "dst_account", "dst_account": "src_account", "dt": "dt_back", "amount_ngn": "amount_back"})
    joined = fwd.merge(rev, on=["src_account", "dst_account"])
    joined = joined[(joined["dt_back"] > joined["dt"]) & (joined["dt_back"] <= joined["dt"] + pd.Timedelta(days=window_days))]
    joined = joined[joined["amount_back"].between(joined["amount_ngn"] * 0.7, joined["amount_ngn"] * 1.0)]
    for src, grp in joined.groupby("src_account"):
        signals.append(InsiderSignal(
            subject=src, kind="embezzlement_pattern", severity=min(1.0, 0.5 + 0.1 * len(grp)),
            evidence=f"{len(grp)} round-trip cycle(s) within {window_days}d (value out ≈ value back)",
        ))

    # Dormant reactivation + drain: no send activity for 90d then >70% of
    # lifetime volume within 24h.
    lifetime = t.groupby("src_account")["amount_ngn"].sum()
    for src, grp in t.sort_values("dt").groupby("src_account"):
        gaps = grp["dt"].diff().dt.days.fillna(0)
        reactivations = grp[gaps >= 90]
        for _, row in reactivations.iterrows():
            after = grp[(grp["dt"] >= row["dt"]) & (grp["dt"] <= row["dt"] + pd.Timedelta(hours=24))]
            total = max(float(lifetime.get(src, 0.0)), 1.0)
            if after["amount_ngn"].sum() >= 0.7 * total:
                signals.append(InsiderSignal(
                    subject=src, kind="embezzlement_pattern", severity=0.9,
                    evidence=f"dormant ≥90d then {after['amount_ngn'].sum() / total:.0%} of lifetime volume moved within 24h",
                ))
    return signals


def gnn_embedding_anomaly(embeddings: np.ndarray, node_ids: list[str], known_benign: set[str]) -> dict[str, float]:
    """Mahalanobis distance of each embedding to the benign centroid (0–1 scaled)."""
    emb = np.asarray(embeddings, dtype=np.float64)
    benign_idx = [i for i, nid in enumerate(node_ids) if nid in known_benign]
    if not benign_idx:
        benign_idx = list(range(len(node_ids)))
    mu = emb[benign_idx].mean(axis=0)
    cov = np.cov(emb[benign_idx].T) + 1e-6 * np.eye(emb.shape[1])
    inv = np.linalg.pinv(cov)
    d = np.sqrt(np.maximum(((emb - mu) @ inv * (emb - mu)).sum(axis=1), 0.0))
    scaled = d / (d.max() + 1e-9)
    return {nid: float(scaled[i]) for i, nid in enumerate(node_ids)}


FUSION_CHANNELS = ["sod_violation", "collusion", "time_abuse", "embezzlement_pattern"]


def fuse_insider_risk(
    signals: list[InsiderSignal],
    embedding_anomaly: dict[str, float],
    mcmc: MCMCSampleSet | None = None,
    training_rows: tuple[np.ndarray, np.ndarray] | None = None,
    seed: int = 42,
) -> list[InsiderRiskAssessment]:
    """Fuse channel evidence + GNN anomaly into a Bayesian insider-risk posterior.

    Feature vector per subject: [max severity per channel (4), embedding anomaly].
    When ``training_rows`` (X, y from synthetic insider scenarios or labelled
    historical reviews) are supplied, the MCMC layer is fitted on them;
    otherwise the provided ``mcmc`` sample set is used. One of the two must be
    given — the fusion never fabricates a posterior.
    """
    if mcmc is None:
        if training_rows is None:
            raise ValueError("fuse_insider_risk requires fitted MCMC samples or training rows")
        mcmc = metropolis_hastings_logistic(training_rows[0], training_rows[1], seed=seed)

    subjects = sorted({s.subject for s in signals} | set(embedding_anomaly))
    if not subjects:
        return []

    rows, ordered = [], []
    for subj in subjects:
        feats = [max((s.severity for s in signals if s.subject == subj and s.kind == ch), default=0.0) for ch in FUSION_CHANNELS]
        feats.append(embedding_anomaly.get(subj, 0.0))
        rows.append(feats)
        ordered.append(subj)
    x = np.asarray(rows, dtype=np.float64)
    mean, lo, hi = mcmc.posterior_predictive(x)
    return [
        InsiderRiskAssessment(
            subject=subj,
            posterior_mean=float(mean[i]),
            ci_lower=float(lo[i]),
            ci_upper=float(hi[i]),
            signals=[s for s in signals if s.subject == subj],
        )
        for i, subj in enumerate(ordered)
    ]
