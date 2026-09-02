#!/usr/bin/env python3
"""Generate local-only validator fixtures; never valid production evidence."""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--output-dir", type=Path, required=True)
    p.add_argument("--release-sha", required=True)
    p.add_argument("--run-id", required=True)
    args = p.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    common = {
        "status": "PASS", "live_cluster_evidence": False, "provenance": "local_fixture",
        "environment": "staging", "release_sha": args.release_sha,
        "reconciliation_run_id": args.run_id,
        "captured_at": datetime.now(timezone.utc).isoformat(),
    }
    observations = {
        "E-01": {"kubernetes_server_version": "v1.30.0-local", "ready_nodes": 3, "context_authorized": True, "cluster_identity_verified": True},
        "E-02": {"database_system_identifier": "local-fixture", "migration_head": "0058", "schema_owner_separation_verified": True, "application_role_ddl_privileges": False, "rls_forced": True, "duplicate_terminal_decisions": 0},
        "E-03": {"application_role_verified": True, "cross_tenant_reads": 0, "cross_tenant_writes": 0, "missing_tenant_context_denied": True, "tenant_rows_verified": 2},
        "E-04": {"tigerbeetle_cluster_id": "local-fixture", "replica_count": 3, "quorum_healthy": True, "views_converged": True, "partition_write_fenced": True, "duplicate_transfer_ids": 0, "reconciliation_mismatches": 0},
        "E-05": {"aml_policy_loaded": True, "sanctions_screening_verified": True, "str_sar_audit_binding_verified": True, "tenant_isolation_verified": True, "alert_delivery_verified": True},
    }
    for evidence_id, obs in observations.items():
        body = dict(common, evidence_id=evidence_id, observations=obs)
        canonical_without_digest = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
        body["evidence_sha256"] = hashlib.sha256(canonical_without_digest).hexdigest()
        (args.output_dir / f"{evidence_id}.json").write_text(json.dumps(body, indent=2) + "\n", encoding="utf-8")
    (args.output_dir / "FIXTURE_WARNING.txt").write_text("LOCAL TEST FIXTURES ONLY. live_cluster_evidence=false. Never use for a production GO decision.\n", encoding="utf-8")
    print(f"wrote local-only E-01..E-05 fixtures to {args.output_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
