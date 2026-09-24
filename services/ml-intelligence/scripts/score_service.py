#!/usr/bin/env python3
"""Run the CPU inference service.

    python scripts/score_service.py --registry /path/to/registry --port 8090
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--registry", required=True)
    p.add_argument("--port", type=int, default=8090)
    p.add_argument("--mlflow-uri", default=None)
    args = p.parse_args()

    import uvicorn
    from umojaflowos_ml.inference import create_app
    app = create_app(args.registry, mlflow_tracking_uri=args.mlflow_uri)
    uvicorn.run(app, host="0.0.0.0", port=args.port)


if __name__ == "__main__":
    main()
