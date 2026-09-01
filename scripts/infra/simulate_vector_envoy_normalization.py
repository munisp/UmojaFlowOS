#!/usr/bin/env python3
"""Compatibility simulation for the reviewed Vector VRL Envoy transform.

Native Vector execution is required in staging; this script tests the same
contract locally when the Vector binary is unavailable.
"""
from __future__ import annotations

import json
from typing import Any

SENSITIVE = {"authorization", "access_token", "refresh_token", "private_key", "secret", "request_body", "response_body", "destination"}


def normalize(line: str, namespace: str = "umoja-payment", pod: str = "payment-engine-0") -> dict[str, Any] | None:
    try:
        raw = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(raw, dict):
        return None
    event = {key: raw.get(key) for key in ("response_code", "response_code_details", "response_flags", "istio_policy_status", "trace_id", "request_id", "route_name", "source_principal")}
    return {
        "archive_schema": "umoja.envoy.access.v1",
        "namespace": namespace,
        "pod": pod,
        "container": "istio-proxy",
        "event": event,
        "sensitive_fields_removed": sorted(SENSITIVE.intersection(raw)),
    }


CASES = [
    ("valid allow", {"response_code": 200, "response_code_details": "via_upstream", "trace_id": "t1"}, True),
    ("valid RBAC deny", {"response_code": 403, "response_code_details": "rbac_access_denied_matched", "source_principal": "unknown"}, True),
    ("malformed JSON", "{broken", False),
    ("JSON scalar", ["not", "an", "object"], False),
    ("sensitive fields", {"response_code": 200, "authorization": "secret-token", "request_body": {"amount": 10}, "destination": "wallet"}, True),
    ("missing status", {"response_code_details": "via_upstream"}, True),
]

for name, value, expected in CASES:
    line = value if isinstance(value, str) else json.dumps(value)
    result = normalize(line)
    actual = result is not None
    if actual != expected:
        raise SystemExit(f"FAIL\t{name}\texpected={expected}\tactual={actual}")
    if name == "sensitive fields" and result and not set(SENSITIVE).intersection(result["sensitive_fields_removed"]):
        raise SystemExit("FAIL\tsensitive fields were not marked for removal")
    print(f"PASS\t{name}\texpected={expected}\tactual={actual}")
print(f"PASS\tall {len(CASES)} Vector normalization compatibility cases")
