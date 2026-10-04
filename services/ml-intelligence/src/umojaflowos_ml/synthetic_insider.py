"""Synthetic insider-threat scenarios for Nigeria-corridor operations.

The fusion layer (insider.py) needs labelled examples of insider abuse to fit
its MCMC posterior before the platform has real cases. These scenarios mirror
documented internal-fraud typologies in West African payment operations:

* ``sod_capture``      — one operator quietly originates and approves their own
                         payment orders / credential activations.
* ``collusion_ring``   — 2–3 operators rotate actions over a captured cluster
                         of counterparties (fake vendors / dormant BDCs).
* ``night_shift_abuse``— privileged actions burst between 00:00 and 05:00.
* ``embezzle_roundtrip``— treasury value cycles out and returns minus a skim,
                          or dormant float accounts drain within 24h of
                          reactivation.
* ``threshold_structuring`` — transfers kept at 90–99% of the four-eyes
                              approval threshold to avoid second review.

Benign operator behaviour is generated alongside so the fusion layer learns
the boundary. All data is synthetic; that is stated on every downstream
metric, consistent with the platform's no-invented-evidence rule.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .insider import FUSION_CHANNELS, SOD_PAIRS

OPERATORS = [f"op_{i:03d}" for i in range(1, 25)]
OBJECTS = [f"obj_{i:04d}" for i in range(1, 400)]


def _base_audit(rng: np.random.Generator, days: int = 30) -> list[dict]:
    rows = []
    for day in range(days):
        for op in OPERATORS:
            for _ in range(rng.poisson(6)):
                obj = rng.choice(OBJECTS)
                pair = rng.choice(list(SOD_PAIRS.keys()))
                role = rng.random() < 0.5
                action = SOD_PAIRS[pair][0] if role else SOD_PAIRS[pair][1]
                hour = int(rng.integers(8, 19))  # business hours
                rows.append({
                    "actor": op, "action": action, "object_id": obj,
                    "ts": pd.Timestamp("2026-08-01", tz="UTC") + pd.Timedelta(days=int(day), hours=hour, minutes=int(rng.integers(0, 60))),
                })
    return rows


def generate_insider_scenarios(seed: int = 42) -> dict[str, pd.DataFrame | np.ndarray]:
    """Return audit frames, transaction frame, and fusion training arrays (X, y)."""
    rng = np.random.default_rng(seed)
    audit = _base_audit(rng)

    # 1) SoD capture: 3 operators self-approve 4 objects each.
    sod_ops = list(rng.choice(OPERATORS, 3, replace=False))
    for op in sod_ops:
        for k in range(4):
            obj = f"sod_obj_{op}_{k}"
            for action in (SOD_PAIRS["payment_order"][0], SOD_PAIRS["payment_order"][1]):
                audit.append({"actor": op, "action": action, "object_id": obj,
                              "ts": pd.Timestamp("2026-08-10", tz="UTC") + pd.Timedelta(hours=10 + k)})

    # 2) Collusion ring: 2 operators own a 12-object cluster (>85% share).
    ring_ops = list(rng.choice([o for o in OPERATORS if o not in sod_ops], 2, replace=False))
    ring_objs = [f"ring_obj_{k}" for k in range(12)]
    for obj in ring_objs:
        for _ in range(6):
            op = ring_ops[0] if rng.random() < 0.9 else ring_ops[1]
            audit.append({"actor": op, "action": rng.choice(["payment_order.create", "payment_leg.create"]),
                          "object_id": obj, "ts": pd.Timestamp("2026-08-12", tz="UTC") + pd.Timedelta(hours=int(rng.integers(8, 18)))})

    # 3) Night-shift abuse: one operator fires 12 privileged actions at 02:00.
    night_op = rng.choice([o for o in OPERATORS if o not in sod_ops + ring_ops])
    for k in range(12):
        audit.append({"actor": night_op, "action": "integration_credential.configure",
                      "object_id": f"night_obj_{k}", "ts": pd.Timestamp("2026-08-15 02:00", tz="UTC") + pd.Timedelta(minutes=3 * k)})

    # 4) Embezzlement: round-trips + structuring + dormant drain.
    threshold = 5_000_000.0
    txns = []
    base = pd.Timestamp("2026-08-01", tz="UTC")
    for k in range(4):  # round trips
        txns.append({"src_account": "NGACC-EMB-1", "dst_account": "NGACC-SHELL-1", "amount_ngn": 2_000_000 + 100_000 * k, "ts": base + pd.Timedelta(days=5 + 2 * k)})
        txns.append({"src_account": "NGACC-SHELL-1", "dst_account": "NGACC-EMB-1", "amount_ngn": 1_800_000 + 90_000 * k, "ts": base + pd.Timedelta(days=7 + 2 * k)})
    for k in range(5):  # structuring at 92–98% of threshold
        txns.append({"src_account": "NGACC-STR-1", "dst_account": f"NGACC-DST-{k}", "amount_ngn": threshold * (0.92 + 0.015 * k), "ts": base + pd.Timedelta(days=3 + k)})
    # dormant reactivation drain
    txns.append({"src_account": "NGACC-DORM-1", "dst_account": "NGACC-OLD", "amount_ngn": 300_000, "ts": base})
    txns.append({"src_account": "NGACC-DORM-1", "dst_account": "NGACC-DRAIN", "amount_ngn": 4_500_000, "ts": base + pd.Timedelta(days=100, hours=2)})
    # benign background traffic
    for k in range(200):
        txns.append({"src_account": f"NGACC-B{k % 40}", "dst_account": f"NGACC-C{k % 55}", "amount_ngn": float(rng.lognormal(11, 1)), "ts": base + pd.Timedelta(days=int(rng.integers(0, 30)), hours=int(rng.integers(8, 18)))})

    audit_df = pd.DataFrame(audit)
    txn_df = pd.DataFrame(txns)

    # Fusion training matrix: subjects × [sod, collusion, time, embezzlement, gnn_anomaly] → insider label.
    subjects = sod_ops + ring_ops + [night_op, "NGACC-EMB-1", "NGACC-STR-1", "NGACC-DORM-1"]
    benign = [o for o in OPERATORS if o not in subjects][:20]
    rows, labels = [], []
    for s in subjects:
        rows.append([
            1.0 if s in sod_ops else 0.0,
            0.9 if s in ring_ops else 0.0,
            0.8 if s == night_op else 0.0,
            0.9 if s.startswith("NGACC-") else 0.0,
            float(rng.uniform(0.7, 1.0)),
        ])
        labels.append(1)
    for s in benign:
        rows.append([0.0, float(rng.uniform(0, 0.15)), 0.0, 0.0, float(rng.uniform(0, 0.3))])
        labels.append(0)
    x = np.asarray(rows, dtype=np.float64)
    y = np.asarray(labels, dtype=np.float64)
    return {"audit": audit_df, "txns": txn_df, "fusion_x": x, "fusion_y": y,
            "insider_subjects": subjects, "approval_threshold": threshold}
