#!/usr/bin/env python3
"""Generate explicitly non-production E-01..E-09 validator fixtures.

These fixtures are for unit/CI validator coverage only. Every artifact is marked
provenance=local_fixture and live_cluster_evidence=false, so they cannot be used
as production regulatory evidence.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

RELEASE_SHA = "a" * 40
RUN_ID = "local-fixture-run-20260902"
CAPTURED_AT = "2026-09-02T12:00:00Z"
DIGEST = "b" * 64

OBSERVATIONS: dict[str, dict[str, object]] = {
    "E-01": {
        "kubernetes_server_version": "v1.31.4",
        "ready_nodes": 3,
        "context_authorized": True,
        "cluster_identity_verified": True,
    },
    "E-02": {
        "database_system_identifier": "local-postgres-system",
        "migration_head": "0060_durable_settlement_fence_state",
        "schema_owner_separation_verified": True,
        "application_role_ddl_privileges": False,
        "rls_forced": True,
        "duplicate_terminal_decisions": 0,
    },
    "E-03": {
        "application_role_verified": True,
        "cross_tenant_reads": 0,
        "cross_tenant_writes": 0,
        "missing_tenant_context_denied": True,
        "tenant_rows_verified": 2,
    },
    "E-04": {
        "tigerbeetle_cluster_id": "local-tigerbeetle-cluster",
        "replica_count": 3,
        "quorum_healthy": True,
        "views_converged": True,
        "partition_write_fenced": True,
        "duplicate_transfer_ids": 0,
        "reconciliation_mismatches": 0,
    },
    "E-05": {
        "aml_policy_loaded": True,
        "sanctions_screening_verified": True,
        "str_sar_audit_binding_verified": True,
        "tenant_isolation_verified": True,
        "alert_delivery_verified": True,
    },
    "E-06": {
        "deployment_digest_verified": True,
        "rollback_executed": True,
        "rollback_health_verified": True,
        "unknown_state_fenced": True,
        "duplicate_submission_check_passed": True,
        "unresolved_reconciliation_conflicts": 0,
        "unauthorized_settlement_attempts": 0,
        "rto_seconds": 120,
        "rpo_seconds": 30,
    },
    "E-07": {
        "trace_context_propagated": True,
        "reconciliation_run_id_propagated": True,
        "tenant_isolation_verified": True,
        "collector_healthy": True,
        "dropped_spans": 0,
        "exporter_errors": 0,
        "services_observed": ["payment-engine", "opa", "postgres"],
    },
    "E-08": {
        "backup_restore_verified": True,
        "tigerbeetle_quorum_recovered": True,
        "postgres_timeline_verified": True,
        "vault_rotation_verified": True,
        "hsm_quorum_verified": True,
        "old_writer_fenced": True,
        "unknown_states_reconciled_safely": True,
        "duplicate_transfers": 0,
        "ledger_discrepancies": 0,
        "rto_seconds": 300,
        "rpo_seconds": 60,
    },
    "E-09": {
        "independent_review_completed": True,
        "manifest_signature_verification_passed": True,
        "worm_object_lock_verified": True,
        "fabric_attestation_verified": True,
        "artifact_hashes_verified": True,
        "artifact_binding_mismatches": 0,
        "artifact_count": 9,
        "independent_reviewer_subject": "local-independent-reviewer",
        "release_manager_subject": "local-release-manager",
    },
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--release-sha", default=RELEASE_SHA)
    parser.add_argument("--run-id", default=RUN_ID)
    args = parser.parse_args()
    if len(args.release_sha) != 40 or any(c not in "0123456789abcdef" for c in args.release_sha):
        raise SystemExit("release SHA must be 40 lowercase hexadecimal characters")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for evidence_id, observations in OBSERVATIONS.items():
        data = {
            "evidence_id": evidence_id,
            "status": "PASS",
            "environment": "staging",
            "provenance": "local_fixture",
            "live_cluster_evidence": False,
            "release_sha": args.release_sha,
            "reconciliation_run_id": args.run_id,
            "captured_at": CAPTURED_AT,
            "evidence_sha256": DIGEST,
            "observations": observations,
        }
        (args.output_dir / f"{evidence_id}.json").write_text(
            json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8"
        )
    print(f"wrote {len(OBSERVATIONS)} explicit local fixtures to {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
