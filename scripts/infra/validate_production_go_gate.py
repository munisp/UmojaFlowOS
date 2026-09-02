#!/usr/bin/env python3
"""Fail-closed production GO gate for the payment-engine deployment.

This checks evidence supplied by an authorized staging/production run. It never
turns local simulations into live evidence.
"""
import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

REQUIRED_LIVE_EVIDENCE = {
    "cluster_version.txt",
    "rollout-status.txt",
    "workload-state.yaml",
    "adapter-hpa-validation-final.json",
    "hpa-live-samples.log",
    "metric-baseline.json",
    "postgres-contention.json",
    "istio-mtls-rbac.json",
    "otel-trace-health.json",
    "fabric-commit-latency.json",
    "vault-rotation-canary.json",
    "worm-object-lock.json",
    "hsm-key-custody.json",
    "dr-recovery.json",
}


def fail(checks, name, detail):
    checks.append({"name": name, "status": "FAIL", "detail": detail})


def pass_(checks, name, detail):
    checks.append({"name": name, "status": "PASS", "detail": detail})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--signatures-dir", type=Path, required=True)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    checks = []

    evidence = args.evidence_dir
    if not evidence.is_dir():
        fail(checks, "evidence_directory", "evidence directory does not exist")
    else:
        missing = sorted(name for name in REQUIRED_LIVE_EVIDENCE if not (evidence / name).is_file())
        if missing:
            fail(checks, "live_evidence_complete", "missing: " + ", ".join(missing))
        else:
            pass_(checks, "live_evidence_complete", "all required live evidence files present")

        hpa = evidence / "adapter-hpa-validation-final.json"
        if hpa.is_file():
            try:
                payload = json.loads(hpa.read_text())
                if payload.get("status") != "PASS" or payload.get("live_cluster_evidence") is not True:
                    fail(checks, "adapter_hpa_live", "external metrics evidence is not a live PASS")
                else:
                    pass_(checks, "adapter_hpa_live", "live external metrics and HPA validation passed")
            except (OSError, json.JSONDecodeError) as exc:
                fail(checks, "adapter_hpa_live", f"invalid JSON: {exc}")

    if not re.fullmatch(r".+@sha256:[0-9a-f]{64}", args.image):
        fail(checks, "immutable_image", "image must use a 64-hex sha256 digest")
    else:
        pass_(checks, "immutable_image", "immutable image digest supplied")

    if not args.manifest.is_file():
        fail(checks, "signed_manifest", "manifest does not exist")
    else:
        try:
            manifest = json.loads(args.manifest.read_text())
            worm = manifest.get("worm", {})
            reconciliation = manifest.get("reconciliation", {})
            required = [worm.get("bucket"), worm.get("object_key_prefix"), worm.get("object_lock_mode"), worm.get("retain_until"), reconciliation.get("run_id")]
            if not all(isinstance(value, str) and value for value in required):
                fail(checks, "manifest_bindings", "WORM and reconciliation bindings are incomplete")
            else:
                retention = datetime.fromisoformat(worm["retain_until"].replace("Z", "+00:00"))
                if retention <= datetime.now(timezone.utc):
                    fail(checks, "manifest_retention", "Object Lock retention timestamp is expired")
                else:
                    pass_(checks, "manifest_bindings", "WORM retention and reconciliation run ID are present")
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            fail(checks, "signed_manifest", f"invalid manifest: {exc}")

    if not args.signatures_dir.is_dir():
        fail(checks, "four_role_signatures", "signature directory does not exist")
    else:
        roles = {path.stem for path in args.signatures_dir.glob("*.json")}
        expected = {"release_manager", "security_owner", "compliance_owner", "operations_owner"}
        if roles != expected:
            fail(checks, "four_role_signatures", f"expected exactly {sorted(expected)}, found {sorted(roles)}")
        else:
            pass_(checks, "four_role_signatures", "exact four approval sidecars present")

    failed = [check for check in checks if check["status"] == "FAIL"]
    result = {
        "status": "PASS" if not failed else "FAIL",
        "production_go": not failed,
        "live_cluster_evidence_required": True,
        "checks": checks,
    }
    print(json.dumps(result, indent=2))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
