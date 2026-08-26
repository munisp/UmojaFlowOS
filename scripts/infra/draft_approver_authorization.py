#!/usr/bin/env python3
"""Draft a pending approval record from a verified enterprise-directory export.

This tool never authorizes a release. It creates a PENDING_OWNER_AUTHORIZATION
record that must be approved and re-issued by the release-governance process.
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROLES = ("release_manager", "security_owner", "compliance_owner", "operations_owner")
SHA_RE = re.compile(r"^[a-f0-9]{40}$")
FORBIDDEN_SUBJECT_MARKERS = ("<", ">", "REPLACE_WITH", "example.invalid", "test-")


def timestamp(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be an ISO-8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{field} must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None:
        raise ValueError(f"{field} must include a timezone")
    return parsed.astimezone(timezone.utc)


def fail(message: str) -> None:
    raise SystemExit(message)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-sha", required=True)
    parser.add_argument("--directory-export", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--max-age-hours", type=float, default=24.0)
    args = parser.parse_args()

    if not SHA_RE.fullmatch(args.release_sha):
        fail("release SHA must be a lowercase 40-character Git SHA")
    if args.max_age_hours <= 0:
        fail("max-age-hours must be positive")
    try:
        export = json.loads(args.directory_export.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read directory export: {error}")

    if not isinstance(export, dict) or export.get("verification_status") != "verified":
        fail("directory export must have verification_status=verified")
    if not isinstance(export.get("source"), str) or not export["source"].strip():
        fail("directory export requires a non-empty source")
    if not isinstance(export.get("verified_by"), str) or not export["verified_by"].strip():
        fail("directory export requires verified_by")
    try:
        retrieved_at = timestamp(export.get("retrieved_at"), "retrieved_at")
    except ValueError as error:
        fail(str(error))
    now = datetime.now(timezone.utc)
    if retrieved_at > now + timedelta(minutes=5):
        fail("directory export retrieved_at cannot be in the future")
    if now - retrieved_at > timedelta(hours=args.max_age_hours):
        fail("directory export is older than max-age-hours")

    entries = export.get("subjects")
    if not isinstance(entries, list) or len(entries) != len(ROLES):
        fail("directory export must contain exactly four subject records")

    owners: list[dict[str, str]] = []
    seen_roles: set[str] = set()
    seen_subjects: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            fail("each directory subject record must be an object")
        role = entry.get("role")
        subject = entry.get("subject")
        if role not in ROLES or role in seen_roles:
            fail(f"invalid or duplicate directory role: {role}")
        if not isinstance(subject, str) or not subject.strip():
            fail(f"{role} requires a non-empty subject")
        if any(marker in subject for marker in FORBIDDEN_SUBJECT_MARKERS):
            fail(f"{role} subject is a placeholder or test identity")
        if subject in seen_subjects:
            fail("directory subjects must be distinct")
        if entry.get("active") is not True:
            fail(f"{role} subject is not active")
        if entry.get("subject_verified") is not True:
            fail(f"{role} subject is not verified")
        if entry.get("role_assignment_verified") is not True:
            fail(f"{role} role assignment is not verified")
        owners.append({"role": role, "subject": subject, "approved_at": "<SET_AFTER_INDEPENDENT_REVIEW>"})
        seen_roles.add(role)
        seen_subjects.add(subject)

    if set(seen_roles) != set(ROLES):
        fail("directory export must contain all four required roles")
    draft = {
        "authorization_status": "PENDING_OWNER_AUTHORIZATION",
        "release_sha": args.release_sha,
        "authorized_at": "<SET_ONLY_AFTER_RELEASE_GOVERNANCE_AUTHORIZATION>",
        "directory_source": export["source"],
        "directory_verified_by": export["verified_by"],
        "directory_retrieved_at": export["retrieved_at"],
        "owners": owners,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(draft, indent=2) + "\n", encoding="utf-8")
    print(f"drafted pending authorization for {len(owners)} verified directory subjects")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
