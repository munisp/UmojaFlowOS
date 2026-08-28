#!/usr/bin/env python3
from __future__ import annotations

import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "assurance/evidence/synthetic_cbn_cohort2"


def replace(value, key=""):
    if isinstance(value, dict):
        return {k: replace(v, k) for k, v in value.items()}
    if isinstance(value, list):
        return [replace(v, key) for v in value]
    if isinstance(value, str):
        if key == "sha256": return "a" * 64
        if key == "uri": return "https://synthetic.invalid/evidence.pdf"
        if key == "owner_subject": return "synthetic-owner"
        if key == "reviewer_subject": return "synthetic-reviewer"
        if key == "primary_subject": return "synthetic-primary"
        if key == "alternate_subject": return "synthetic-alternate"
        if key == "approver_subject": return "synthetic-approver"
        if key == "authorised_signatory_subject": return "synthetic-signatory"
        if key == "dossier_id": return "synthetic-dossier-001"
        if key == "legal_name": return "Synthetic Umoja Applicant Limited"
        if key == "registered_address": return "Synthetic test address, Lagos, Nigeria"
        if key == "nigeria_connection": return "Synthetic Nigerian incorporation connection for local validation only"
        if key == "problem": return "Synthetic controlled payment risk problem for validation only"
        if key == "market_benefit": return "Synthetic measurable market benefit for validation only"
        if key == "title": return "Synthetic evidence document"
        if key in {"version"}: return "v1"
        if "REPLACE_WITH" in value or value.startswith("replace-with-"): return "Synthetic populated value for local validation only"
        return value
    return value


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    dossier = json.loads((ROOT / "assurance/cbn_vasp_application_dossier.template.json").read_text())
    governance = json.loads((ROOT / "assurance/cbn_vasp_governance.template.json").read_text())
    dossier = replace(dossier)
    governance = replace(governance)
    dossier["documents"] = [
        {"id":"risk-framework-v1","title":"Synthetic risk framework","uri":"https://synthetic.invalid/risk-framework.pdf","sha256":"b"*64,"owner_subject":"synthetic-risk-owner","reviewer_subject":"synthetic-risk-reviewer","version":"v1","issued_at":"2026-08-28T00:00:00Z"}
    ]
    # Make officer subjects unique while preserving primary/alternate separation.
    for index, officer in enumerate(governance["officers"]):
        officer["primary_subject"] = f"synthetic-primary-{index}"
        officer["alternate_subject"] = f"synthetic-alternate-{index}"
    for approval_index, approval in enumerate(governance["approvals"]):
        approval["approver_subject"] = f"synthetic-approver-{approval_index}"
    (OUT / "dossier.json").write_text(json.dumps(dossier, indent=2) + "\n")
    (OUT / "governance.json").write_text(json.dumps(governance, indent=2) + "\n")
    (OUT / "NOTICE.txt").write_text("Synthetic local validation fixture only. It contains no real legal identity, officer, licence, approval, or external evidence and must never be submitted to CBN.\n")
    print(OUT)


if __name__ == "__main__":
    main()
