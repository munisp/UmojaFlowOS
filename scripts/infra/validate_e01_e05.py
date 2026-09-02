#!/usr/bin/env python3
"""Validate structured E-01..E-05 evidence summaries.

Each runner must emit a JSON summary with common provenance fields plus the
fields defined for its evidence ID. This validator intentionally rejects raw
logs without a signed/structured summary; it never infers PASS from filenames.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

SHA40 = re.compile(r"^[a-f0-9]{40}$")
SHA64 = re.compile(r"^[a-f0-9]{64}$")
RUN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
REQUIRED = {"E-01", "E-02", "E-03", "E-04", "E-05"}


def fail(message: str) -> None:
    raise SystemExit(f"{message}")


def require(data: dict, key: str, typ: type) -> object:
    value = data.get(key)
    if not isinstance(value, typ):
        fail(f"missing or invalid {key}")
    return value


def timestamp(value: object, field: str) -> None:
    if not isinstance(value, str):
        fail(f"{field} must be an ISO-8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        fail(f"{field} is invalid: {exc}")
    if parsed.tzinfo is None:
        fail(f"{field} must include a timezone")


def positive(data: dict, key: str) -> None:
    value = data.get(key)
    if not isinstance(value, int) or value <= 0:
        fail(f"{key} must be a positive integer")


def validate_common(data: dict, evidence_id: str, release_sha: str, run_id: str, local_fixture: bool) -> None:
    if data.get("evidence_id") != evidence_id:
        fail(f"evidence_id must be {evidence_id}")
    if data.get("status") != "PASS":
        fail("status must be PASS")
    if data.get("environment") != "staging":
        fail("environment must be staging")
    if local_fixture:
        if data.get("provenance") != "local_fixture" or data.get("live_cluster_evidence") is not False:
            fail("local fixture must be explicitly marked local_fixture and live_cluster_evidence=false")
    elif data.get("live_cluster_evidence") is not True or data.get("provenance") != "authorized_staging":
        fail("live evidence must be marked authorized_staging")
    if data.get("release_sha") != release_sha or not SHA40.fullmatch(release_sha):
        fail("release_sha mismatch or invalid")
    if data.get("reconciliation_run_id") != run_id or not RUN.fullmatch(run_id):
        fail("reconciliation_run_id mismatch or invalid")
    timestamp(require(data, "captured_at", str), "captured_at")
    digest = require(data, "evidence_sha256", str)
    if not SHA64.fullmatch(digest):
        fail("evidence_sha256 must be 64 lowercase hexadecimal characters")
    observations = require(data, "observations", dict)
    if not observations:
        fail("observations must not be empty")


def validate_e01(o: dict) -> None:
    require(o, "kubernetes_server_version", str)
    nodes = require(o, "ready_nodes", int)
    if nodes < 1:
        fail("ready_nodes must be at least 1")
    if o.get("context_authorized") is not True:
        fail("context_authorized must be true")
    if o.get("cluster_identity_verified") is not True:
        fail("cluster_identity_verified must be true")


def validate_e02(o: dict) -> None:
    require(o, "database_system_identifier", str)
    require(o, "migration_head", str)
    if o.get("schema_owner_separation_verified") is not True:
        fail("schema_owner_separation_verified must be true")
    if o.get("application_role_ddl_privileges") is not False:
        fail("application_role_ddl_privileges must be false")
    if o.get("rls_forced") is not True:
        fail("rls_forced must be true")
    if o.get("duplicate_terminal_decisions") != 0:
        fail("duplicate_terminal_decisions must be zero")


def validate_e03(o: dict) -> None:
    if o.get("application_role_verified") is not True:
        fail("application_role_verified must be true")
    if o.get("cross_tenant_reads") != 0 or o.get("cross_tenant_writes") != 0:
        fail("cross-tenant access must be zero")
    if o.get("missing_tenant_context_denied") is not True:
        fail("missing_tenant_context_denied must be true")
    if o.get("tenant_rows_verified") != 2:
        fail("tenant_rows_verified must equal the approved test count of 2")


def validate_e04(o: dict) -> None:
    require(o, "tigerbeetle_cluster_id", str)
    positive(o, "replica_count")
    if o.get("replica_count", 0) < 3:
        fail("replica_count must be at least 3 for quorum evidence")
    if o.get("quorum_healthy") is not True or o.get("views_converged") is not True:
        fail("TigerBeetle quorum and converged views are required")
    if o.get("partition_write_fenced") is not True:
        fail("partition_write_fenced must be true")
    if o.get("duplicate_transfer_ids") != 0:
        fail("duplicate_transfer_ids must be zero")
    if o.get("reconciliation_mismatches") != 0:
        fail("reconciliation_mismatches must be zero")


def validate_e05(o: dict) -> None:
    if o.get("aml_policy_loaded") is not True:
        fail("aml_policy_loaded must be true")
    if o.get("sanctions_screening_verified") is not True:
        fail("sanctions_screening_verified must be true")
    if o.get("str_sar_audit_binding_verified") is not True:
        fail("str_sar_audit_binding_verified must be true")
    if o.get("tenant_isolation_verified") is not True:
        fail("tenant_isolation_verified must be true")
    if o.get("alert_delivery_verified") is not True:
        fail("alert_delivery_verified must be true")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence-id", required=True, choices=sorted(REQUIRED))
    parser.add_argument("--artifact", type=Path, required=True)
    parser.add_argument("--release-sha", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--local-fixture", action="store_true")
    args = parser.parse_args()
    if not SHA40.fullmatch(args.release_sha) or not RUN.fullmatch(args.run_id):
        fail("invalid release SHA or run ID")
    try:
        data = json.loads(args.artifact.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"cannot read structured evidence: {exc}")
    if not isinstance(data, dict):
        fail("evidence must be a JSON object")
    validate_common(data, args.evidence_id, args.release_sha, args.run_id, args.local_fixture)
    observations = data["observations"]
    if args.evidence_id == "E-01": validate_e01(observations)
    elif args.evidence_id == "E-02": validate_e02(observations)
    elif args.evidence_id == "E-03": validate_e03(observations)
    elif args.evidence_id == "E-04": validate_e04(observations)
    else: validate_e05(observations)
    print(json.dumps({"evidence_id": args.evidence_id, "status": "PASS", "local_fixture": args.local_fixture, "release_sha": args.release_sha, "reconciliation_run_id": args.run_id}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise SystemExit(1)
