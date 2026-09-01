#!/usr/bin/env python3
"""Simulate Envoy JSON access-log edge cases for the gRPC security harness."""
from __future__ import annotations

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).with_name("test_settlement_grpc_staging_security.py")
spec = importlib.util.spec_from_file_location("security_harness", SCRIPT)
if spec is None or spec.loader is None:
    raise SystemExit("unable to load security harness")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

CASES = [
    ("valid allow 200", [{"response_code": 200, "response_code_details": "via_upstream", "response_flags": "-"}], 200, False, True),
    ("valid RBAC deny 403", [{"response_code": 403, "response_code_details": "rbac_access_denied_matched", "response_flags": "-"}], 403, True, True),
    ("malformed plus valid allow", ["not-json", {"response_code": 200, "response_code_details": "via_upstream"}], 200, False, True),
    ("missing status code", [{"response_code_details": "rbac_access_denied_matched"}], 403, True, False),
    ("non-RBAC 403", [{"response_code": 403, "response_code_details": "upstream_reset_before_response_started"}], 403, True, False),
    ("allow marked RBAC denied", [{"response_code": 200, "response_code_details": "rbac_access_denied_matched"}], 200, False, False),
    ("wrong status for allow", [{"response_code": 201, "response_code_details": "via_upstream"}], 200, False, False),
    ("wrong status for deny", [{"response_code": 401, "response_code_details": "rbac_access_denied_matched"}], 403, True, False),
    ("denial signal in policy status", [{"response_code": 403, "istio_policy_status": "denied-by-rbac"}], 403, True, True),
]

for name, records, expected_code, denied, expected in CASES:
    parsed = module._json_access_log_lines("\n".join(record if isinstance(record, str) else __import__("json").dumps(record) for record in records))
    actual = True
    try:
        module._assert_envoy_status(parsed, expected_code, denied)
    except module.CheckFailure:
        actual = False
    status = "PASS" if actual == expected else "FAIL"
    print(f"{status}\t{name}\texpected={expected}\tactual={actual}")
    if status == "FAIL":
        raise SystemExit(1)
print(f"PASS\tall {len(CASES)} Envoy edge cases matched expected behavior")
