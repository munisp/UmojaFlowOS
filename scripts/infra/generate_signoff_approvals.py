#!/usr/bin/env python3
"""Generate the approval array only from an explicit authorized owner record."""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROLES = ("release_manager", "security_owner", "compliance_owner", "operations_owner")
SHA_RE = re.compile(r"^[a-f0-9]{40}$")


def parse_timestamp(value: object, field: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be an ISO-8601 timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"{field} must include a timezone")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-sha", required=True)
    parser.add_argument("--authorization-record", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    if not SHA_RE.fullmatch(args.release_sha):
        raise SystemExit("release SHA must be a lowercase 40-character Git SHA")
    try:
        record = json.loads(args.authorization_record.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"cannot read authorization record: {error}") from error

    if record.get("authorization_status") != "AUTHORIZED_FOR_RELEASE_SIGNOFF":
        raise SystemExit("authorization record is not explicitly authorized for release sign-off")
    if record.get("release_sha") != args.release_sha:
        raise SystemExit("authorization record release SHA does not match requested release SHA")
    parse_timestamp(record.get("authorized_at"), "authorized_at")

    owners = record.get("owners")
    if not isinstance(owners, list) or len(owners) != len(ROLES):
        raise SystemExit("authorization record must contain exactly four owner records")

    approvals: list[dict[str, str]] = []
    seen_roles: set[str] = set()
    seen_subjects: set[str] = set()
    now = datetime.now(timezone.utc)
    for owner in owners:
        if not isinstance(owner, dict):
            raise SystemExit("each owner record must be an object")
        role = owner.get("role")
        subject = owner.get("subject")
        approved_at = owner.get("approved_at")
        if role not in ROLES or role in seen_roles:
            raise SystemExit(f"invalid or duplicate approval role: {role}")
        if not isinstance(subject, str) or not subject.strip() or "REPLACE_WITH" in subject:
            raise SystemExit(f"{role} requires a real non-placeholder subject")
        if subject in seen_subjects:
            raise SystemExit("approval subjects must be distinct")
        timestamp = parse_timestamp(approved_at, f"{role}.approved_at")
        if timestamp > now:
            raise SystemExit(f"{role}.approved_at cannot be in the future")
        approvals.append({"role": role, "subject": subject, "release_sha": args.release_sha, "approved_at": approved_at})
        seen_roles.add(role)
        seen_subjects.add(subject)

    if set(seen_roles) != set(ROLES):
        raise SystemExit("all four independent approval roles are required")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(approvals, indent=2) + "\n", encoding="utf-8")
    print(f"generated {len(approvals)} authorized approval payloads for {args.release_sha}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
