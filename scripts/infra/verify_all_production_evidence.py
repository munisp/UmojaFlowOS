#!/usr/bin/env python3
"""Run the complete fail-closed release evidence verification sequence."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

REQUIRED = (
    "cluster_version.txt", "rollout-status.txt", "workload-state.yaml",
    "adapter-hpa-validation-final.json", "hpa-live-samples.log", "metric-baseline.json",
    "postgres-contention.json", "istio-mtls-rbac.json", "otel-trace-health.json",
    "fabric-commit-latency.json", "vault-rotation-canary.json", "worm-object-lock.json",
    "hsm-key-custody.json", "dr-recovery.json",
)


def canonical_manifest(manifest: dict) -> bytes:
    return json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_artifact_signatures(bundle: Path, manifest_path: Path, signatures_dir: Path, artifact_signatures_dir: Path, release_sha: str, run_id: str) -> dict[str, object]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("release_sha") != release_sha or manifest.get("reconciliation", {}).get("run_id") != run_id:
        raise SystemExit("NO-GO: manifest release/run binding mismatch before artifact signature verification")
    approvals = {entry.get("role"): entry for entry in manifest.get("approvals", [])}
    expected_roles = {"release_manager", "security_owner", "compliance_owner", "operations_owner"}
    if set(approvals) != expected_roles:
        raise SystemExit("NO-GO: manifest does not contain exactly the four required approval roles")
    trusted_keys: dict[str, bytes] = {}
    for role in expected_roles:
        sidecar = json.loads((signatures_dir / f"{role}.json").read_text(encoding="utf-8"))
        try:
            key = base64.b64decode(sidecar["public_key"], validate=True)
        except (KeyError, ValueError) as exc:
            raise SystemExit(f"NO-GO: invalid public key for {role}: {exc}") from exc
        if len(key) != 32:
            raise SystemExit(f"NO-GO: {role} public key must be 32 bytes")
        trusted_keys[role] = key
    checked = 0
    for filename in REQUIRED:
        evidence = bundle / filename
        actual_sha = file_sha256(evidence)
        envelope = json.dumps({
            "filename": filename,
            "sha256": actual_sha,
            "release_sha": release_sha,
            "reconciliation_run_id": run_id,
        }, sort_keys=True, separators=(",", ":")).encode("utf-8")
        for role, public_bytes in trusted_keys.items():
            sidecar_path = artifact_signatures_dir / role / f"{filename}.json"
            if not sidecar_path.is_file():
                raise SystemExit(f"NO-GO: missing artifact signature {sidecar_path}")
            sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
            required = {"filename", "sha256", "release_sha", "reconciliation_run_id", "role", "algorithm", "public_key", "signature"}
            if set(sidecar) != required:
                raise SystemExit(f"NO-GO: invalid fields in {sidecar_path}")
            if sidecar["filename"] != filename or sidecar["sha256"] != actual_sha or sidecar["release_sha"] != release_sha or sidecar["reconciliation_run_id"] != run_id or sidecar["role"] != role or sidecar["algorithm"] != "Ed25519":
                raise SystemExit(f"NO-GO: artifact signature binding mismatch in {sidecar_path}")
            try:
                key = base64.b64decode(sidecar["public_key"], validate=True)
                signature = base64.b64decode(sidecar["signature"], validate=True)
            except (ValueError, KeyError) as exc:
                raise SystemExit(f"NO-GO: malformed artifact signature in {sidecar_path}: {exc}") from exc
            if key != public_bytes or len(signature) != 64:
                raise SystemExit(f"NO-GO: artifact signature key mismatch or invalid length in {sidecar_path}")
            try:
                Ed25519PublicKey.from_public_bytes(public_bytes).verify(signature, envelope)
            except Exception as exc:
                raise SystemExit(f"NO-GO: artifact signature verification failed for {sidecar_path}: {exc}") from exc
            checked += 1
    return {"name": "artifact_signatures", "status": "PASS", "checked": checked, "files": len(REQUIRED), "roles": len(expected_roles)}


def run(label: str, command: list[str], report: list[dict[str, object]]) -> None:
    completed = subprocess.run(command, text=True, capture_output=True)
    record = {"name": label, "status": "PASS" if completed.returncode == 0 else "FAIL", "exit_code": completed.returncode, "command": command}
    if completed.stdout:
        record["stdout"] = completed.stdout[-12000:]
    if completed.stderr:
        record["stderr"] = completed.stderr[-12000:]
    report.append(record)
    if completed.returncode != 0:
        raise SystemExit(json.dumps({"status": "NO-GO", "failed_step": label, "checks": report}, indent=2))


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--repo", type=Path, required=True)
    p.add_argument("--bundle-dir", type=Path, required=True)
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--signatures-dir", type=Path, required=True)
    p.add_argument("--artifact-signatures-dir", type=Path, required=True)
    p.add_argument("--structured-evidence-dir", type=Path, help="directory containing E-01.json through E-05.json summaries")
    p.add_argument("--release-sha", required=True)
    p.add_argument("--run-id", required=True)
    p.add_argument("--image", required=True)
    p.add_argument("--artifact-validator", action="append", default=[], metavar="NAME=COMMAND", help="optional command; shell is never used")
    args = p.parse_args()
    report: list[dict[str, object]] = []
    bundle = args.bundle_dir.resolve()
    if not bundle.is_dir():
        raise SystemExit("NO-GO: bundle directory does not exist")
    missing = [name for name in REQUIRED if not (bundle / name).is_file()]
    if missing:
        raise SystemExit("NO-GO: normalized bundle missing: " + ", ".join(missing))

    py = sys.executable
    run("manifest schema and artifact digest verification", [py, str(args.repo / "scripts/infra/verify_production_release_evidence.py"), "--manifest", str(args.manifest), "--expected-sha", args.release_sha], report)
    run("four-role Ed25519 signature verification", [py, str(args.repo / "scripts/infra/verify_release_manifest_signatures.py"), "--manifest", str(args.manifest), "--schema", str(args.repo / "assurance/release_evidence_manifest.schema.json"), "--signatures-dir", str(args.signatures_dir), "--expected-sha", args.release_sha], report)
    report.append(verify_artifact_signatures(args.bundle_dir.resolve(), args.manifest.resolve(), args.signatures_dir.resolve(), args.artifact_signatures_dir.resolve(), args.release_sha, args.run_id))
    if args.structured_evidence_dir is not None:
        for evidence_id in ("E-01", "E-02", "E-03", "E-04", "E-05"):
            run(f"artifact-specific validator {evidence_id}", [py, str(args.repo / "scripts/infra/validate_e01_e05.py"), "--evidence-id", evidence_id, "--artifact", str(args.structured_evidence_dir / f"{evidence_id}.json"), "--release-sha", args.release_sha, "--run-id", args.run_id], report)
        for evidence_id in ("E-06", "E-07", "E-08", "E-09"):
            run(f"artifact-specific validator {evidence_id}", [py, str(args.repo / "scripts/infra/validate_e06_e09.py"), "--evidence-id", evidence_id, "--artifact", str(args.structured_evidence_dir / f"{evidence_id}.json"), "--release-sha", args.release_sha, "--run-id", args.run_id], report)
    for spec in args.artifact_validator:
        if "=" not in spec:
            raise SystemExit("NO-GO: --artifact-validator requires NAME=COMMAND")
        name, command = spec.split("=", 1)
        argv = command.split()
        if not argv:
            raise SystemExit(f"NO-GO: empty validator command for {name}")
        run(f"artifact validator {name}", argv, report)
    run("production GO gate", [py, str(args.repo / "scripts/infra/validate_production_go_gate.py"), "--evidence-dir", str(bundle), "--manifest", str(args.manifest), "--signatures-dir", str(args.signatures_dir), "--image", args.image], report)
    print(json.dumps({"status": "PASS", "production_go": True, "checks": report}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
