"""A/B testing infrastructure for model comparison in production.

Champion (production stage) vs challenger (staging stage) routing with
deterministic assignment so a given entity always sees the same model during
an experiment. Promotion requires the challenger to beat the champion on the
guardrail metric by a margin with a minimum sample size.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, asdict
from pathlib import Path

import numpy as np
from sklearn.metrics import average_precision_score, roc_auc_score

from .registry import ModelRegistry
from .schemas import utcnow


@dataclass
class Experiment:
    name: str
    model_family: str
    champion_version: str
    challenger_version: str
    challenger_traffic_pct: float = 10.0
    started_at: str = field(default_factory=lambda: utcnow().isoformat())
    status: str = "running"          # running | promoted | rejected
    guardrail_metric: str = "pr_auc"
    min_samples: int = 1000


class ABExperimentStore:
    def __init__(self, root: Path | str):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "experiments.json"

    def _load(self) -> dict:
        return json.loads(self.path.read_text()) if self.path.exists() else {"experiments": {}}

    def _save(self, data: dict) -> None:
        self.path.write_text(json.dumps(data, indent=2, sort_keys=True))

    def create(self, exp: Experiment) -> None:
        data = self._load()
        data["experiments"][exp.name] = asdict(exp)
        self._save(data)

    def get(self, name: str) -> Experiment:
        return Experiment(**self._load()["experiments"][name])

    def update(self, exp: Experiment) -> None:
        data = self._load()
        data["experiments"][exp.name] = asdict(exp)
        self._save(data)


def route_assignment(exp: Experiment, entity_key: str) -> str:
    """Deterministic champion/challenger assignment from entity key."""
    h = int(hashlib.sha256(f"{exp.name}:{entity_key}".encode()).hexdigest(), 16) % 10_000
    return "challenger" if h < exp.challenger_traffic_pct * 100 else "champion"


def evaluate_experiment(
    exp: Experiment,
    y_true: np.ndarray,
    champion_scores: np.ndarray,
    challenger_scores: np.ndarray,
    promotion_margin: float = 0.01,
) -> dict:
    """Compare champion vs challenger on labelled outcomes; decide promotion."""
    n = len(y_true)
    result = {"experiment": exp.name, "n_samples": n, "decided": False}
    if n < exp.min_samples:
        result["reason"] = f"insufficient samples ({n} < {exp.min_samples})"
        return result
    metric = average_precision_score if exp.guardrail_metric == "pr_auc" else roc_auc_score
    c_val = float(metric(y_true, champion_scores))
    ch_val = float(metric(y_true, challenger_scores))
    result.update({
        "decided": True,
        f"champion_{exp.guardrail_metric}": c_val,
        f"challenger_{exp.guardrail_metric}": ch_val,
        "uplift": ch_val - c_val,
    })
    if ch_val >= c_val + promotion_margin:
        result["decision"] = "promote_challenger"
    elif c_val >= ch_val + promotion_margin:
        result["decision"] = "keep_champion"
    else:
        result["decision"] = "inconclusive_extend"
    return result


def apply_decision(registry: ModelRegistry, store: ABExperimentStore, exp_name: str, decision: str) -> Experiment:
    exp = store.get(exp_name)
    if decision == "promote_challenger":
        registry.promote(exp.model_family, exp.challenger_version, "production")
        exp.status = "promoted"
    elif decision == "keep_champion":
        exp.status = "rejected"
    store.update(exp)
    return exp
