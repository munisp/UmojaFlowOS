#!/usr/bin/env python3
"""Validate structured E-06..E-09 evidence summaries.

This validator requires live, authorized evidence by default. --local-fixture
exists only for unit-test fixtures and can never be used by the production GO
orchestrator.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

SHA40 = re.compile(r"^[a-f0-9]{40}$")
SHA64 = re.compile(r"^[a-f0-9]{64}$")
RUN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
IDS = {"E-06", "E-07", "E-08", "E-09"}


def stop(message: str) -> None:
    raise SystemExit(f"VALIDATION FAILED: {message}")


def req(obj: dict, key: str, typ: type):
    value = obj.get(key)
    if not isinstance(value, typ):
        stop(f"missing or invalid {key}")
    return value


def yes(obj: dict, key: str) -> None:
    if obj.get(key) is not True:
        stop(f"{key} must be true")


def zero(obj: dict, key: str) -> None:
    if obj.get(key) != 0:
        stop(f"{key} must be zero")


def timestamp(value: object, field: str) -> None:
    if not isinstance(value, str):
        stop(f"{field} must be an ISO-8601 timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        stop(f"invalid {field}: {exc}")
    if parsed.tzinfo is None:
        stop(f"{field} must include a timezone")


def common(data: dict, expected_id: str, release_sha: str, run_id: str, local_fixture: bool) -> dict:
    if data.get("evidence_id") != expected_id or data.get("status") != "PASS":
        stop("evidence ID or status is invalid")
    if data.get("environment") != "staging":
        stop("environment must be staging")
    if data.get("release_sha") != release_sha or not SHA40.fullmatch(release_sha):
        stop("release SHA mismatch or invalid")
    if data.get("reconciliation_run_id") != run_id or not RUN.fullmatch(run_id):
        stop("reconciliation run ID mismatch or invalid")
    timestamp(req(data, "captured_at", str), "captured_at")
    digest = req(data, "evidence_sha256", str)
    if not SHA64.fullmatch(digest):
        stop("evidence_sha256 must be 64 lowercase hexadecimal characters")
    if local_fixture:
        if data.get("provenance") != "local_fixture" or data.get("live_cluster_evidence") is not False:
            stop("local fixture must be explicitly marked local_fixture and live_cluster_evidence=false")
    elif data.get("live_cluster_evidence") is not True or data.get("provenance") != "authorized_staging":
        stop("live evidence must be marked authorized_staging")
    return req(data, "observations", dict)


def e06(o: dict) -> None:
    yes(o, "deployment_digest_verified")
    yes(o, "rollback_executed")
    yes(o, "rollback_health_verified")
    yes(o, "unknown_state_fenced")
    yes(o, "duplicate_submission_check_passed")
    zero(o, "unresolved_reconciliation_conflicts")
    zero(o, "unauthorized_settlement_attempts")
    if o.get("rto_seconds", 0) <= 0 or o.get("rpo_seconds", 0) < 0:
        stop("RTO/RPO values are invalid")


def e07(o: dict) -> None:
    yes(o, "trace_context_propagated")
    yes(o, "reconciliation_run_id_propagated")
    yes(o, "tenant_isolation_verified")
    yes(o, "collector_healthy")
    zero(o, "dropped_spans")
    zero(o, "exporter_errors")
    services = req(o, "services_observed", list)
    if len(services) < 3 or len({str(item) for item in services}) != len(services):
        stop("at least three unique observed services are required")


def e08(o: dict) -> None:
    yes(o, "backup_restore_verified")
    yes(o, "tigerbeetle_quorum_recovered")
    yes(o, "postgres_timeline_verified")
    yes(o, "vault_rotation_verified")
    yes(o, "hsm_quorum_verified")
    yes(o, "old_writer_fenced")
    yes(o, "unknown_states_reconciled_safely")
    zero(o, "duplicate_transfers")
    zero(o, "ledger_discrepancies")
    if o.get("rto_seconds", 0) <= 0 or o.get("rpo_seconds", 0) < 0:
        stop("DR RTO/RPO values are invalid")


def e09(o: dict) -> None:
    yes(o, "independent_review_completed")
    yes(o, "manifest_signature_verification_passed")
    yes(o, "worm_object_lock_verified")
    yes(o, "fabric_attestation_verified")
    yes(o, "artifact_hashes_verified")
    zero(o, "artifact_binding_mismatches")
    if o.get("independent_reviewer_subject", "") == o.get("release_manager_subject", ""):
        stop("independent reviewer must differ from release manager")
    if o.get("artifact_count") != 9:
        stop("artifact_count must equal 9 for E-01 through E-09")


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--evidence-id", required=True, choices=sorted(IDS))
    p.add_argument("--artifact", type=Path, required=True)
    p.add_argument("--release-sha", required=True)
    p.add_argument("--run-id", required=True)
    p.add_argument("--local-fixture", action="store_true")
    args = p.parse_args()
    try:
        data = json.loads(args.artifact.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        stop(f"cannot read artifact: {exc}")
    if not isinstance(data, dict):
        stop("artifact must be a JSON object")
    obs = common(data, args.evidence_id, args.release_sha, args.run_id, args.local_fixture)
    {"E-06": e06, "E-07": e07, "E-08": e08, "E-09": e09}[args.evidence_id](obs)
    print(json.dumps({"evidence_id": args.evidence_id, "status": "PASS", "local_fixture": args.local_fixture}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        print(f"VALIDATION FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
