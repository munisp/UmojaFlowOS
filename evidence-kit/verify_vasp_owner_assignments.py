#!/usr/bin/env python3
"""Validate six-owner VASP readiness declarations for CI; makes no API calls."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

EXPECTED = {
    "controlled_live_test": (7, "product_and_risk_owner"),
    "governance_legal_ownership": (8, "board_legal_company_secretary"),
    "aml_cft_cpf_operations": (14, "mlro_compliance_owner"),
    "customer_asset_safeguarding": (13, "custody_treasury_owner"),
    "cybersecurity_resilience": (10, "ciso_platform_sre_owner"),
    "consumer_incident_reporting": (6, "consumer_protection_cbn_liaison"),
}


def fail(message: str) -> None:
    print(f"owner-assignment validation failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def populated(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip()) and "<" not in value and ">" not in value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("assignments", type=Path)
    args = parser.parse_args()
    document = json.loads(args.assignments.read_text(encoding="utf-8"))
    if document.get("track") != "vasp": fail("track must be vasp")
    dossier_id = document.get("dossierId")
    if not isinstance(dossier_id, str) or not re.fullmatch(r"[0-9a-fA-F-]{36}", dossier_id): fail("dossierId must be a UUID")
    rows = document.get("assignments")
    if not isinstance(rows, list) or len(rows) != 6: fail("exactly six owner assignments are required")
    seen: set[str] = set()
    for row in rows:
        area = row.get("area")
        if area not in EXPECTED or area in seen: fail(f"unsupported or duplicate area: {area}")
        seen.add(area)
        points, role = EXPECTED[area]
        if row.get("points") != points or row.get("accountableRole") != role:
            fail(f"{area}: points or accountableRole does not match the fixed readiness register")
        for key in ("externalEvidenceOwner", "externalContact", "platformSubmitterSubject", "platformVerifierSubject"):
            if not populated(row.get(key)): fail(f"{area}: {key} must be a real non-placeholder value")
        if "@" not in row["externalContact"]: fail(f"{area}: externalContact must be an email-like address")
        if row["platformSubmitterSubject"] == row["platformVerifierSubject"]:
            fail(f"{area}: platform verifier must differ from platform submitter")
    if seen != set(EXPECTED): fail("assignments must cover every fixed readiness area")
    print("validated six VASP readiness owner assignments; no platform role or evidence state was changed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
