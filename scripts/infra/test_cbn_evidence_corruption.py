#!/usr/bin/env python3
"""Negative tests for CBN dossier identity and evidence-integrity validation.

The fixtures are synthetic and must never be submitted to CBN.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = ROOT / "scripts/infra/validate_cbn_vasp_application.py"
SOURCE = ROOT / "assurance/evidence/synthetic_cbn_cohort2"


def run_case(dossier: dict, governance: dict, expected: str) -> None:
    with tempfile.TemporaryDirectory(prefix="cbn-corruption-") as td:
        work = Path(td)
        dossier_path = work / "dossier.json"
        governance_path = work / "governance.json"
        dossier_path.write_text(json.dumps(dossier), encoding="utf-8")
        governance_path.write_text(json.dumps(governance), encoding="utf-8")
        result = subprocess.run(
            [sys.executable, str(VALIDATOR), "--dossier", str(dossier_path),
             "--governance", str(governance_path), "--repo", str(ROOT)],
            text=True, capture_output=True, check=False,
        )
        combined = result.stdout + result.stderr
        if result.returncode == 0 or expected not in combined:
            raise AssertionError(
                f"expected validator failure containing {expected!r}; "
                f"exit={result.returncode}; output={combined}"
            )


def main() -> int:
    dossier = json.loads((SOURCE / "dossier.json").read_text(encoding="utf-8"))
    governance = json.loads((SOURCE / "governance.json").read_text(encoding="utf-8"))

    duplicate = json.loads(json.dumps(governance))
    duplicate["officers"][1]["primary_subject"] = duplicate["officers"][0]["primary_subject"]
    run_case(dossier, duplicate, "all primary and alternate subjects must be distinct")
    print("PASS duplicate subject corruption rejected")

    corrupted_hash = json.loads(json.dumps(dossier))
    corrupted_hash["documents"][0]["sha256"] = "0" * 63 + "g"
    run_case(corrupted_hash, governance, "sha256")
    print("PASS corrupted SHA-256 evidence rejected")

    owner_reviewer = json.loads(json.dumps(dossier))
    ref = owner_reviewer["documents"][0]
    ref["reviewer_subject"] = ref["owner_subject"]
    run_case(owner_reviewer, governance, "document owner and reviewer must be distinct")
    print("PASS owner/reviewer self-review rejected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

