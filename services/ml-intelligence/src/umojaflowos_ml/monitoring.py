"""Model monitoring: drift detection and performance-degradation alerts.

* Population Stability Index (PSI) and Kolmogorov-Smirnov per feature vs the
  training baseline captured at train time.
* Performance tracking against the registered baseline metrics; alerts when
  live PR-AUC/ROC-AUC degrades beyond tolerance.
* Alerts are emitted as JSON lines (alert sink is pluggable: file, stdout, or
  the platform's alertmanager webhook).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from scipy import stats as scipy_stats  # scipy ships with sklearn; fallback below

from .schemas import DriftReport, MonitoringAlert, utcnow

PSI_WARNING = 0.1
PSI_CRITICAL = 0.25


def population_stability_index(baseline: np.ndarray, current: np.ndarray, bins: int = 10) -> float:
    qs = np.linspace(0, 100, bins + 1)
    edges = np.unique(np.percentile(baseline, qs))
    if len(edges) < 2:
        return 0.0
    b_hist, _ = np.histogram(baseline, bins=edges)
    c_hist, _ = np.histogram(current, bins=edges)
    b = np.clip(b_hist / max(b_hist.sum(), 1), 1e-4, None)
    c = np.clip(c_hist / max(c_hist.sum(), 1), 1e-4, None)
    return float(np.sum((b - c) * np.log(b / c)))


def ks_statistic(baseline: np.ndarray, current: np.ndarray) -> float:
    try:
        return float(scipy_stats.ks_2samp(baseline, current).statistic)
    except Exception:
        b = np.sort(baseline)
        c = np.sort(current)
        all_v = np.concatenate([b, c])
        cdf_b = np.searchsorted(b, all_v, side="right") / len(b)
        cdf_c = np.searchsorted(c, all_v, side="right") / len(c)
        return float(np.max(np.abs(cdf_b - cdf_c)))


def detect_drift(
    baseline: dict[str, np.ndarray],
    current: dict[str, np.ndarray],
) -> list[DriftReport]:
    reports = []
    for feature, base in baseline.items():
        cur = current.get(feature)
        if cur is None or len(cur) == 0:
            continue
        psi = population_stability_index(np.asarray(base), np.asarray(cur))
        ks = ks_statistic(np.asarray(base), np.asarray(cur))
        reports.append(DriftReport(feature=feature, psi=psi, ks_statistic=ks, drifted=psi >= PSI_WARNING))
    return reports


def performance_alerts(
    model_name: str,
    baseline_metrics: dict[str, float],
    live_metrics: dict[str, float],
    tolerance: float = 0.05,
) -> list[MonitoringAlert]:
    alerts = []
    for key in ("pr_auc", "roc_auc"):
        base = baseline_metrics.get(key)
        live = live_metrics.get(key)
        if base is None or live is None:
            continue
        drop = base - live
        if drop > tolerance:
            alerts.append(MonitoringAlert(
                alert="model_performance_degradation",
                severity="critical" if drop > 2 * tolerance else "warning",
                detail={"model": model_name, "metric": key, "baseline": base, "live": live, "drop": drop},
            ))
    return alerts


def drift_alerts(model_name: str, reports: list[DriftReport]) -> list[MonitoringAlert]:
    alerts = []
    for r in reports:
        if r.psi >= PSI_CRITICAL:
            alerts.append(MonitoringAlert("feature_drift", "critical", {"model": model_name, "feature": r.feature, "psi": r.psi}))
        elif r.psi >= PSI_WARNING:
            alerts.append(MonitoringAlert("feature_drift", "warning", {"model": model_name, "feature": r.feature, "psi": r.psi}))
    return alerts


class AlertSink:
    def __init__(self, path: Path | str | None = None):
        self.path = Path(path) if path else None
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, alerts: list[MonitoringAlert]) -> int:
        if not alerts:
            return 0
        lines = [json.dumps({"alert": a.alert, "severity": a.severity, "detail": a.detail, "raised_at": a.raised_at}) for a in alerts]
        if self.path:
            with self.path.open("a") as fh:
                fh.write("\n".join(lines) + "\n")
        return len(lines)
