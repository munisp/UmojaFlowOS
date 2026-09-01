#!/usr/bin/env python3
"""Deterministic microbenchmark for the staging Envoy JSON parser helpers."""
from __future__ import annotations

import importlib.util
import json
import time
from pathlib import Path

SCRIPT = Path(__file__).with_name("test_settlement_grpc_staging_security.py")
spec = importlib.util.spec_from_file_location("security_harness", SCRIPT)
if spec is None or spec.loader is None:
    raise SystemExit("unable to load security harness")
module = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(module)

record = json.dumps({"response_code": 200, "response_code_details": "via_upstream", "response_flags": "-", "route_name": "settlement-grpc"})
lines = "\n".join([record] * 100_000)
start = time.perf_counter()
records = module._json_access_log_lines(lines)
elapsed = time.perf_counter() - start
module._assert_envoy_status(records, 200, denied=False)
print(json.dumps({
    "records": len(records),
    "input_bytes": len(lines.encode()),
    "elapsed_seconds": round(elapsed, 6),
    "records_per_second": round(len(records) / elapsed),
    "megabytes_per_second": round(len(lines.encode()) / elapsed / 1_000_000, 3),
    "note": "synthetic repeated JSON lines; excludes kubectl transport and cluster log delivery",
}, indent=2))
