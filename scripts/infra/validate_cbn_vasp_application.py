#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]
PLACEHOLDER = re.compile(r"(?:REPLACE_WITH|TODO|TBD|EXAMPLE|<[^>]+>)", re.IGNORECASE)


def load(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read JSON: {path}") from exc


def validate_schema(document, schema, label: str) -> list[str]:
    errors = sorted(Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(document), key=lambda e: list(e.path))
    return [f"{label}: {'/'.join(map(str, e.path)) or '<root>'}: {e.message}" for e in errors]


def walk_objects(value):
    if isinstance(value, dict):
        yield value
        for item in value.values(): yield from walk_objects(item)
    elif isinstance(value, list):
        for item in value: yield from walk_objects(item)


def semantic_errors(dossier, governance) -> list[str]:
    errors: list[str] = []
    dossier_id = dossier.get("dossier_id")
    if dossier_id and governance.get("dossier_id") != dossier_id:
        errors.append("governance.dossier_id must equal dossier.dossier_id")
    for label, document in (("dossier", dossier), ("governance", governance)):
        for obj in walk_objects(document):
            for key in ("subject", "primary_subject", "alternate_subject", "owner_subject", "reviewer_subject", "authorised_signatory_subject", "legal_name", "registered_address"):
                value = obj.get(key)
                if isinstance(value, str) and PLACEHOLDER.search(value):
                    errors.append(f"{label}: placeholder value is not permitted in {key}")
    officers = governance.get("officers", [])
    officer_subjects: list[str] = []
    for index, officer in enumerate(officers):
        primary, alternate = officer.get("primary_subject"), officer.get("alternate_subject")
        if primary == alternate:
            errors.append(f"governance.officers[{index}]: primary and alternate subjects must differ")
        officer_subjects.extend(x for x in (primary, alternate) if isinstance(x, str))
    if len(officer_subjects) != len(set(officer_subjects)):
        errors.append("governance.officers: all primary and alternate subjects must be distinct")
    for label, document in (("dossier", dossier), ("governance", governance)):
        for index, obj in enumerate(walk_objects(document)):
            if "owner_subject" in obj and obj.get("owner_subject") == obj.get("reviewer_subject"):
                errors.append(f"{label}: document owner and reviewer must be distinct at object {index}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dossier", type=Path, required=True)
    parser.add_argument("--governance", type=Path, required=True)
    parser.add_argument("--repo", type=Path, default=ROOT)
    args = parser.parse_args()
    try:
        dossier = load(args.dossier)
        governance = load(args.governance)
        dossier_schema = load(args.repo / "assurance/cbn_vasp_application_dossier.schema.json")
        governance_schema = load(args.repo / "assurance/cbn_vasp_governance.schema.json")
    except ValueError as exc:
        print(f"DOSSIER_INVALID: {exc}", file=sys.stderr)
        return 1
    errors = validate_schema(dossier, dossier_schema, "dossier")
    errors.extend(validate_schema(governance, governance_schema, "governance"))
    if not errors:
        errors.extend(semantic_errors(dossier, governance))
    if errors:
        for error in errors: print(f"DOSSIER_INVALID: {error}", file=sys.stderr)
        return 1
    print(f"validated CBN VASP dossier and governance package: dossier_id={dossier['dossier_id']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
