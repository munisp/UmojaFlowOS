#!/usr/bin/env python3
"""Reject local-only evidence when invoked for a production release gate."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def reject(path: Path) -> None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"NO-GO: cannot read evidence JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise SystemExit(f"NO-GO: evidence JSON must be an object: {path}")
    if value.get("provenance") == "local_fixture":
        raise SystemExit(f"NO-GO: local_fixture provenance is forbidden: {path}")
    if value.get("live_cluster_evidence") is False:
        raise SystemExit(f"NO-GO: live_cluster_evidence=false is forbidden: {path}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--structured-evidence-dir", type=Path)
    args = parser.parse_args()
    reject(args.manifest)
    if args.structured_evidence_dir is not None:
        for path in sorted(args.structured_evidence_dir.glob("E-*.json")):
            reject(path)
    print("production evidence provenance: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
