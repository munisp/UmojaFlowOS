"""EPR-style evidence-pattern retrieval for KGQA over the platform graph.

Implements the core of "Evidence Pattern Retrieval" (Ding & Huo, 2024) adapted
from academic KGs to the platform's operational knowledge graph:

1.  Index the **atomic adjacency pattern** of every entity pair — for each
    (source, relation, target) fact, the pair (relation, direction) is an
    atomic pattern.
2.  Given a natural-language question, dense-retrieve the atomic patterns
    whose embedded resource pairs overlap the question's entities.
3.  Enumerate combinations of retrieved atomic patterns into candidate
    **evidence patterns**, score them with a small neural scorer, and extract
    the subgraph covered by the best pattern.

The extracted evidence subgraph is then handed to the advisory layer (ollama
narration in kg_pipeline.py) together with its provenance. The answer is
always grounded in — and limited to — retrieved facts; the KGQA layer never
invents relations that are not in the graph.

Dependencies stay light: sentence embeddings default to a deterministic
hashing encoder so the pipeline runs on CPU with no model download; a real
sentence-transformer can be injected via ``encoder``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from itertools import combinations

import numpy as np
import torch
import torch.nn as nn

EMB_DIM = 128


def hashing_encoder(texts: list[str], dim: int = EMB_DIM) -> np.ndarray:
    """Deterministic token-hashing encoder (CPU, no downloads)."""
    out = np.zeros((len(texts), dim), dtype=np.float32)
    for r, text in enumerate(texts):
        for tok in text.lower().split():
            h = hash(tok) % dim
            out[r, h] += 1.0
        norm = np.linalg.norm(out[r]) or 1.0
        out[r] /= norm
    return out


@dataclass(frozen=True)
class Fact:
    src: str
    relation: str
    dst: str
    meta: dict = field(default_factory=dict)


@dataclass
class AtomicPattern:
    relation: str
    direction: str            # "out" | "in"
    embedding: np.ndarray


@dataclass
class EvidencePattern:
    patterns: list[AtomicPattern]
    score: float
    facts: list[Fact]


class PatternScorer(nn.Module):
    """Tiny neural scorer for candidate evidence patterns (trained offline)."""

    def __init__(self, dim: int = EMB_DIM):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(2 * dim, 64), nn.ReLU(), nn.Linear(64, 1))

    def forward(self, question_emb: torch.Tensor, pattern_emb: torch.Tensor) -> torch.Tensor:
        return self.net(torch.cat([question_emb, pattern_emb], dim=-1)).squeeze(-1)


class EvidencePatternIndex:
    """Indexes facts as atomic adjacency patterns and retrieves evidence subgraphs."""

    def __init__(self, encoder=hashing_encoder):
        self.encoder = encoder
        self.facts: list[Fact] = []
        self.patterns: list[AtomicPattern] = []
        self._pattern_emb: np.ndarray | None = None

    def add_facts(self, facts: list[Fact]) -> None:
        self.facts.extend(facts)
        new: list[AtomicPattern] = []
        for f in facts:
            for direction in ("out", "in"):
                text = f"{f.src} {f.relation} {f.dst}" if direction == "out" else f"{f.dst} {f.relation} {f.src}"
                new.append(AtomicPattern(f.relation, direction, self.encoder([text])[0]))
        self.patterns.extend(new)
        self._pattern_emb = np.stack([p.embedding for p in self.patterns])

    def retrieve_atomic(self, question: str, top_k: int = 8) -> list[AtomicPattern]:
        if self._pattern_emb is None or not self.patterns:
            return []
        q = self.encoder([question])[0]
        sims = self._pattern_emb @ q
        order = np.argsort(-sims)[:top_k]
        return [self.patterns[i] for i in order if sims[i] > 0]

    def evidence_subgraph(
        self,
        question: str,
        scorer: PatternScorer | None = None,
        top_k: int = 8,
        max_pattern_size: int = 3,
    ) -> EvidencePattern:
        """Retrieve, combine, score, and extract the best evidence subgraph."""
        atomic = self.retrieve_atomic(question, top_k=top_k)
        if not atomic:
            return EvidencePattern([], 0.0, [])
        q_emb = torch.tensor(self.encoder([question])[0], dtype=torch.float32)
        best = EvidencePattern([], 0.0, [])
        for size in range(1, min(max_pattern_size, len(atomic)) + 1):
            for combo in combinations(atomic, size):
                rels = {p.relation for p in combo}
                facts = [f for f in self.facts if f.relation in rels]
                if not facts:
                    continue
                if scorer is not None:
                    p_emb = torch.tensor(np.mean([p.embedding for p in combo], axis=0), dtype=torch.float32)
                    with torch.no_grad():
                        score = float(torch.sigmoid(scorer(q_emb, p_emb)))
                else:
                    # Coverage heuristic when no trained scorer is supplied.
                    score = len(facts) / max(len(self.facts), 1) + 0.1 * size
                if score > best.score:
                    best = EvidencePattern(list(combo), float(score), facts)
        return best


def platform_facts_from_records(
    counterparties: list[dict],
    integrations: list[dict],
    payment_orders: list[dict],
) -> list[Fact]:
    """Project canonical PostgreSQL records into KG facts for EPR indexing."""
    facts: list[Fact] = []
    for c in counterparties:
        facts.append(Fact(c["id"], "registered_as", c["counterpartyType"]))
        facts.append(Fact(c["id"], "domiciled_in", c.get("jurisdiction", "unknown")))
    for i in integrations:
        facts.append(Fact(i["id"], "connects_counterparty", i["counterpartyId"]))
        facts.append(Fact(i["id"], "provides_capability", i["category"]))
        facts.append(Fact(i["id"], "has_state", i["state"]))
    for p in payment_orders:
        facts.append(Fact(p["id"], "in_corridor", p["corridor"]))
        facts.append(Fact(p["id"], "has_status", p["status"]))
    return facts
