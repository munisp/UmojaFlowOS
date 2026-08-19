#!/usr/bin/env python3
"""Loads the committed Permify schema and a minimal relationship set.

This exists so the live authorization state is reproducible from the repository
rather than from a shell history. It writes the schema in `infra/permify/
schema.perm` verbatim — the file is the source of truth, not this script — and
then writes the relationship tuples the live regression depends on.

The tuples written here are structural, not operational: they describe that a
test organisation exists and which role a test subject holds. They contain no
customer, no counterparty, and no monetary value.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = REPO_ROOT / "infra" / "permify" / "schema.perm"


def post(base_url: str, path: str, body: dict) -> dict:
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:3476")
    parser.add_argument("--tenant", default="t1")
    args = parser.parse_args()

    if not SCHEMA_PATH.is_file():
        print(f"schema not found at {SCHEMA_PATH}", file=sys.stderr)
        return 2

    schema = SCHEMA_PATH.read_text(encoding="utf-8")
    try:
        written = post(args.base_url, f"/v1/tenants/{args.tenant}/schemas/write", {"schema": schema})
    except urllib.error.URLError as error:
        print(f"could not reach permify at {args.base_url}: {error}", file=sys.stderr)
        return 1
    print(f"schema version {written.get('schema_version')}")

    tuples = {
        "metadata": {"schema_version": ""},
        "tuples": [
            {
                "entity": {"type": "organization", "id": "org1"},
                "relation": "compliance_officer",
                "subject": {"type": "user", "id": "u1"},
            },
            {
                "entity": {"type": "payment_order", "id": "o1"},
                "relation": "organization",
                "subject": {"type": "organization", "id": "org1"},
            },
        ],
    }
    result = post(args.base_url, f"/v1/tenants/{args.tenant}/data/write", tuples)
    print(f"relationships written, snap token {result.get('snap_token')}")

    # Verify rather than assume: a provisioning script that reports success
    # without checking is how a deny-by-default system quietly becomes
    # allow-by-accident.
    check = post(
        args.base_url,
        f"/v1/tenants/{args.tenant}/permissions/check",
        {
            "metadata": {"depth": 20},
            "entity": {"type": "payment_order", "id": "o1"},
            "permission": "manage_treasury",
            "subject": {"type": "user", "id": "u1"},
        },
    )
    if check.get("can") != "CHECK_RESULT_DENIED":
        print(f"role separation is not being enforced: {check}", file=sys.stderr)
        return 1
    print("verified: a compliance officer holds no treasury permission")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
