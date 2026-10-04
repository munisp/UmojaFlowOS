"""MCMC Bayesian inference for fraud and insider-risk calibration.

Closes the gap "no probabilistic calibration": point-estimate scores from the
deep models are wrapped in a Bayesian logistic layer fitted by Markov Chain
Monte Carlo, so every advisory score carries a posterior predictive
distribution and a credible interval — not just a single number.

Design choices, all deliberate:
* Pure NumPy/CPU Metropolis-Hastings with adaptive proposal covariance
  (Roberts & Rosenthal scaling) — no PyMC/Stan dependency, so inference and
  training run anywhere the rest of the stack runs, including CPU-only nodes.
* Posterior samples are persisted as ``.npz`` so they are reproducible and
  auditable; the sampler is seeded end-to-end.
* Outputs remain advisory review evidence. A wide credible interval is itself
  the signal: it tells the reviewer the model is uncertain, which a point
  score cannot express.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .schemas import utcnow

DEFAULT_SEED = 42


def _sigmoid(z: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(z, -35.0, 35.0)))


def _log_posterior(beta: np.ndarray, x: np.ndarray, y: np.ndarray, prior_var: float) -> float:
    """Log posterior for Bayesian logistic regression with N(0, prior_var·I) prior."""
    p = _sigmoid(x @ beta)
    ll = float(np.sum(y * np.log(np.clip(p, 1e-12, 1.0)) + (1 - y) * np.log(np.clip(1 - p, 1e-12, 1.0))))
    lp = -0.5 * float(beta @ beta) / prior_var
    return ll + lp


@dataclass
class MCMCSampleSet:
    """Persisted MCMC output: posterior draws plus sampler diagnostics."""

    samples: np.ndarray          # (S, D) posterior draws of coefficients
    acceptance_rate: float
    mean: np.ndarray             # (D,) posterior mean
    ci_lower: np.ndarray         # (D,) 2.5% quantile
    ci_upper: np.ndarray         # (D,) 97.5% quantile
    sampled_at: str

    def posterior_predictive(self, x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Return (mean, 2.5%, 97.5%) posterior predictive probability per row.

        Accepts features without the intercept column; it is appended here so
        callers never have to know about the sampler's internal augmentation.
        """
        x = np.asarray(x, dtype=np.float64)
        if x.shape[1] == self.samples.shape[1] - 1:
            x = np.hstack([x, np.ones((x.shape[0], 1))])
        probs = _sigmoid(self.samples @ x.T)  # (S, N)
        return (
            probs.mean(axis=0),
            np.quantile(probs, 0.025, axis=0),
            np.quantile(probs, 0.975, axis=0),
        )

    def save(self, path: Path | str) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            path,
            samples=self.samples,
            acceptance_rate=np.array([self.acceptance_rate]),
            sampled_at=np.array([self.sampled_at]),
        )
        return path

    @classmethod
    def load(cls, path: Path | str) -> "MCMCSampleSet":
        data = np.load(path, allow_pickle=False)
        samples = data["samples"]
        return cls(
            samples=samples,
            acceptance_rate=float(data["acceptance_rate"][0]),
            mean=samples.mean(axis=0),
            ci_lower=np.quantile(samples, 0.025, axis=0),
            ci_upper=np.quantile(samples, 0.975, axis=0),
            sampled_at=str(data["sampled_at"][0]),
        )


def metropolis_hastings_logistic(
    x: np.ndarray,
    y: np.ndarray,
    draws: int = 4000,
    burn_in: int = 1000,
    prior_var: float = 10.0,
    step_size: float = 0.05,
    seed: int = DEFAULT_SEED,
    target_acceptance: tuple[float, float] = (0.2, 0.5),
) -> MCMCSampleSet:
    """Adaptive Metropolis-Hastings sampler for Bayesian logistic regression.

    The proposal covariance is adapted during burn-in towards a 0.234 target
    acceptance rate (optimal for random-walk Metropolis in moderate
    dimensions), then fixed for the sampling phase so the stationary
    distribution is preserved.
    """
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    n, d = x.shape
    x_aug = np.hstack([x, np.ones((n, 1))])  # intercept column
    rng = np.random.default_rng(seed)

    beta = np.zeros(d + 1)
    cov = np.eye(d + 1) * (step_size ** 2)
    log_post = _log_posterior(beta, x_aug, y, prior_var)

    kept: list[np.ndarray] = []
    accepted = 0
    total = draws + burn_in
    adapt_window = 50
    window_accepted = 0

    for it in range(total):
        proposal = rng.multivariate_normal(beta, cov)
        prop_lp = _log_posterior(proposal, x_aug, y, prior_var)
        if np.log(rng.random()) < prop_lp - log_post:
            beta, log_post = proposal, prop_lp
            accepted += 1
            window_accepted += 1
        # Adapt proposal covariance during burn-in only.
        if it < burn_in and (it + 1) % adapt_window == 0:
            rate = window_accepted / adapt_window
            lo, hi = target_acceptance
            scale = 1.1 if rate > hi else (0.9 if rate < lo else 1.0)
            cov = cov * (scale ** 2)
            window_accepted = 0
        if it >= burn_in:
            kept.append(beta.copy())

    samples = np.asarray(kept)
    return MCMCSampleSet(
        samples=samples,
        acceptance_rate=accepted / total,
        mean=samples.mean(axis=0),
        ci_lower=np.quantile(samples, 0.025, axis=0),
        ci_upper=np.quantile(samples, 0.975, axis=0),
        sampled_at=utcnow().isoformat(),
    )


def calibrate_scores_mcmc(
    model_scores: np.ndarray,
    features: np.ndarray,
    y: np.ndarray,
    seed: int = DEFAULT_SEED,
    **sampler_kwargs,
) -> MCMCSampleSet:
    """Fit the Bayesian calibration layer on (deep score + raw features) → label.

    The deep model's logit is prepended as the first regressor, so the MCMC
    layer learns how much to trust the point model given the evidence — and
    expresses residual uncertainty through the posterior spread.
    """
    logits = np.log(np.clip(model_scores, 1e-6, 1 - 1e-6) / (1 - np.clip(model_scores, 1e-6, 1 - 1e-6)))
    design = np.column_stack([logits, features])
    return metropolis_hastings_logistic(design, y, seed=seed, **sampler_kwargs)
