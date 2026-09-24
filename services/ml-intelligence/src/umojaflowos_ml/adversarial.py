"""Adversarial robustness evaluation (IBM ART) for the fraud models.

Closes the gap "models never stress-tested": a deployed fraud scorer faces
adversaries who deliberately perturb transaction features to evade detection.
This module measures and hardens against that.

* If the Adversarial Robustness Toolbox (``adversarial-robustness-toolbox``,
  Linux Foundation AI & Data) is installed, its FGSM/PGD implementations are
  used through the ``PyTorchClassifier`` wrapper — the peer-reviewed reference
  implementations.
* Otherwise (default, dependency-light), equivalent FGSM and PGD attacks are
  implemented directly in PyTorch with the same definitions, so the robustness
  gate runs in CI on CPU without extra packages.

All results are evaluation evidence only; they harden the advisory models and
never change any control decision path.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import torch
import torch.nn as nn

try:  # optional, heavier dependency with reference attack implementations
    from art.attacks.evasion import FastGradientMethod as _ARTFGSM
    from art.attacks.evasion import ProjectedGradientDescent as _ARTPGD
    from art.estimators.classification import PyTorchClassifier as _ARTClassifier

    _HAS_ART = True
except Exception:  # pragma: no cover - environment dependent
    _HAS_ART = False

EPSILON_GRID = (0.01, 0.05, 0.1, 0.2)


def _fgsm(model: nn.Module, x: torch.Tensor, y: torch.Tensor, eps: float) -> torch.Tensor:
    x_adv = x.clone().detach().requires_grad_(True)
    loss = nn.functional.binary_cross_entropy_with_logits(model(x_adv).reshape(-1), y)
    grad = torch.autograd.grad(loss, x_adv)[0]
    return (x_adv + eps * grad.sign()).detach()


def _pgd(model: nn.Module, x: torch.Tensor, y: torch.Tensor, eps: float, steps: int = 20, alpha: float | None = None) -> torch.Tensor:
    alpha = alpha if alpha is not None else eps / max(steps // 2, 1)
    x_adv = x.clone().detach() + torch.empty_like(x).uniform_(-eps, eps)
    for _ in range(steps):
        x_adv.requires_grad_(True)
        loss = nn.functional.binary_cross_entropy_with_logits(model(x_adv).reshape(-1), y)
        grad = torch.autograd.grad(loss, x_adv)[0]
        x_adv = (x_adv.detach() + alpha * grad.sign()).clamp_min(float("-inf"))
        x_adv = x + (x_adv - x).clamp(-eps, eps)
    return x_adv.detach()


@dataclass
class RobustnessReport:
    model: str
    clean_fraud_recall: float
    attacks: dict[str, dict[float, float]] = field(default_factory=dict)  # name -> eps -> recall under attack
    art_backend: bool = _HAS_ART

    @property
    def worst_recall(self) -> float:
        vals = [r for per_eps in self.attacks.values() for r in per_eps.values()]
        return min(vals) if vals else self.clean_fraud_recall


def _recall_at(model: nn.Module, x: torch.Tensor, y: torch.Tensor, threshold: float = 0.5) -> float:
    with torch.no_grad():
        prob = torch.sigmoid(model(x).reshape(-1))
    pred = (prob >= threshold).float()
    positives = y == 1
    if positives.sum() == 0:
        return 0.0
    return float((pred[positives] * y[positives]).sum() / positives.sum())


def evaluate_evasion(
    model: nn.Module,
    x: np.ndarray,
    y: np.ndarray,
    model_name: str = "fraud_net",
    epsilons: tuple[float, ...] = EPSILON_GRID,
) -> RobustnessReport:
    """Measure fraud-class recall under FGSM and PGD evasion at several epsilons.

    The report answers the operational question: if a fraudster nudges amount,
    timing and device features within ±ε of their true values, how much of the
    fraud class does the model still catch? A large drop mandates adversarial
    training (``adversarial_train``) before the next registry promotion.
    """
    model.eval()
    xt = torch.tensor(x, dtype=torch.float32)
    yt = torch.tensor(np.asarray(y, dtype=np.float32), dtype=torch.float32)
    report = RobustnessReport(model=model_name, clean_fraud_recall=_recall_at(model, xt, yt))

    if _HAS_ART:  # pragma: no cover - requires optional dependency
        classifier = _ARTClassifier(
            model=model,
            loss=nn.BCEWithLogitsLoss(),
            optimizer=torch.optim.Adam(model.parameters(), lr=1e-3),
            input_shape=(x.shape[1],),
            nb_classes=2,
            clip_values=(float(x.min()), float(x.max())),
        )
        for name, ctor in (("fgsm", _ARTFGSM), ("pgd", _ARTPGD)):
            report.attacks[name] = {}
            for eps in epsilons:
                attack = ctor(classifier, eps=eps)
                x_adv = attack.generate(x=x.astype(np.float32))
                report.attacks[name][eps] = _recall_at(model, torch.tensor(x_adv, dtype=torch.float32), yt)
        return report

    for name, fn in (("fgsm", _fgsm), ("pgd", _pgd)):
        report.attacks[name] = {}
        for eps in epsilons:
            report.attacks[name][eps] = _recall_at(model, fn(model, xt, yt, eps), yt)
    return report


def adversarial_train(
    model: nn.Module,
    x: np.ndarray,
    y: np.ndarray,
    epochs: int = 10,
    eps: float = 0.1,
    lr: float = 1e-3,
    batch_size: int = 256,
    seed: int = 42,
) -> nn.Module:
    """PGD adversarial training (Madry et al.) on tabular fraud features.

    Each minibatch is first perturbed by PGD; the loss is taken on the
    perturbed batch, teaching the model to stay correct under bounded
    adversarial movement. CPU-friendly: small models, small batches.
    """
    torch.manual_seed(seed)
    model.train()
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    xt = torch.tensor(x, dtype=torch.float32)
    yt = torch.tensor(np.asarray(y, dtype=np.float32), dtype=torch.float32)
    n = len(xt)
    for _ in range(epochs):
        perm = torch.randperm(n)
        for i in range(0, n, batch_size):
            idx = perm[i : i + batch_size]
            xb, yb = xt[idx], yt[idx]
            model.eval()
            xb_adv = _pgd(model, xb, yb, eps=eps, steps=7)
            model.train()
            opt.zero_grad()
            loss = nn.functional.binary_cross_entropy_with_logits(model(xb_adv).reshape(-1), yb)
            loss.backward()
            opt.step()
    model.eval()
    return model


def poisoning_suspect_report(
    train_features: np.ndarray,
    train_labels: np.ndarray,
    influence_threshold: float = 3.0,
) -> dict:
    """Flag training rows whose removal would most change the decision boundary.

    A cheap, deterministic proxy for ART's poisoning defences: rows whose
    standardised feature norm is extreme AND whose label is in the minority
    class are the highest-leverage rows an insider could plant. They are
    returned as review evidence for the training-data steward — not dropped
    automatically.
    """
    x = np.asarray(train_features, dtype=np.float64)
    y = np.asarray(train_labels)
    z = (x - x.mean(axis=0)) / (x.std(axis=0) + 1e-9)
    leverage = np.linalg.norm(z, axis=1)
    minority = 1 if (y == 1).sum() <= (y == 0).sum() else 0
    suspects = np.where((leverage > influence_threshold) & (y == minority))[0]
    return {
        "minority_class": int(minority),
        "suspect_rows": suspects.tolist(),
        "suspect_count": int(len(suspects)),
        "leverage_threshold": influence_threshold,
    }
