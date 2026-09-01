#!/usr/bin/env python3
"""Deterministic microbenchmark for the staging Envoy JSON parser helpers."""
from __future__ import annotations

import importlib.util
import io
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
sample, saw_allow, saw_deny = module._inspect_envoy_logs(io.StringIO(lines), max_samples=64)
elapsed = time.perf_counter() - start
if not saw_allow or saw_deny:
    raise SystemExit("unexpected streaming parser result")
print(json.dumps({
    "records": 100_000,
    "bounded_sample_size": len(sample),
    "input_bytes": len(lines.encode()),
    "elapsed_seconds": round(elapsed, 6),
    "records_per_second": round(100_000 / elapsed),
    "megabytes_per_second": round(len(lines.encode()) / elapsed / 1_000_000, 3),
    "note": "synthetic repeated JSON lines; excludes kubectl transport and cluster log delivery",
}, indent=2))
