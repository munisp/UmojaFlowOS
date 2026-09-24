#!/usr/bin/env python3
"""Train the full UmojaFlowOS model stack end to end.

Usage:
    python scripts/train_all.py --workspace /path/to/workspace [--quick]

Produces: Lakehouse bronze/silver/gold partitions, trained weights (.pt) with
sha256 + metrics (.json), a local model registry, and (optionally) MLflow
tracking when MLFLOW_TRACKING_URI is set.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from umojaflowos_ml.continuous import run_continuous_cycle  # noqa: E402


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--workspace", required=True)
    p.add_argument("--quick", action="store_true", help="small corpus + few epochs for CI")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--mlflow-uri", default=None)
    args = p.parse_args()

    if args.quick:
        report = run_continuous_cycle(
            args.workspace, n_accounts=1500, n_txns=30_000, seed=args.seed,
            epochs_fraud=8, epochs_credit=8, epochs_gnn=30, epochs_ae=6,
            mlflow_tracking_uri=args.mlflow_uri,
        )
    else:
        report = run_continuous_cycle(
            args.workspace, n_accounts=4000, n_txns=120_000, seed=args.seed,
            mlflow_tracking_uri=args.mlflow_uri,
        )
    print(json.dumps({
        "cycle_id": report.cycle_id,
        "versions": report.versions,
        "ab_decision": report.ab_decision,
        "drifted_features": report.drifted_features,
        "provenance": report.provenance,
        "metrics": {k: {m: round(v, 4) for m, v in mv.items()} for k, mv in report.metrics.items()},
    }, indent=2))


if __name__ == "__main__":
    main()
