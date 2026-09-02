#!/usr/bin/env python3
"""Sign an existing normalized evidence bundle; never create evidence.

This creates per-artifact detached signatures for all 14 GO-gate files and the
four release-manifest sidecars consumed by verify_release_manifest_signatures.py.
Private keys must be supplied from an approved HSM export/signing bridge and are
never copied into the output bundle.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROLES = ("release_manager", "security_owner", "compliance_owner", "operations_owner")
FILES = (
    "cluster_version.txt", "rollout-status.txt", "workload-state.yaml",
    "adapter-hpa-validation-final.json", "hpa-live-samples.log", "metric-baseline.json",
    "postgres-contention.json", "istio-mtls-rbac.json", "otel-trace-health.json",
    "fabric-commit-latency.json", "vault-rotation-canary.json", "worm-object-lock.json",
    "hsm-key-custody.json", "dr-recovery.json",
)
SHA_RE = re.compile(r"^[a-f0-9]{40}$")
RUN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")


def fail(message: str) -> None:
    raise SystemExit(f"SIGNING FAILED: {message}")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def b64(value: bytes) -> str:
    return base64.b64encode(value).decode("ascii")


def load_key(path: Path) -> Ed25519PrivateKey:
    if not path.is_file():
        fail(f"private key is missing: {path}")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        fail(f"private key permissions are too broad; require 0600: {path}")
    try:
        key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    except Exception as exc:  # cryptography provides several exception types
        fail(f"cannot load Ed25519 private key {path}: {exc}")
    if not isinstance(key, Ed25519PrivateKey):
        fail(f"key is not Ed25519: {path}")
    return key


def canonical_manifest(value: dict) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--bundle-dir", type=Path, required=True)
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--signatures-dir", type=Path, required=True)
    p.add_argument("--artifact-signatures-dir", type=Path, required=True)
    p.add_argument("--release-sha", required=True)
    p.add_argument("--run-id", required=True)
    p.add_argument("--private-key", action="append", required=True, metavar="ROLE=PATH")
    args = p.parse_args()

    if not SHA_RE.fullmatch(args.release_sha):
        fail("release SHA must be 40 lowercase hexadecimal characters")
    if not RUN_RE.fullmatch(args.run_id):
        fail("invalid reconciliation run ID")
    bundle = args.bundle_dir.resolve()
    manifest_path = args.manifest.resolve()
    if not bundle.is_dir() or not manifest_path.is_file():
        fail("bundle and manifest must already exist")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:
        fail(f"invalid manifest JSON: {exc}")
    if manifest.get("release_sha") != args.release_sha:
        fail("manifest release_sha mismatch")
    if manifest.get("reconciliation", {}).get("run_id") != args.run_id:
        fail("manifest reconciliation.run_id mismatch")
    if manifest.get("environment") not in {"staging", "production"}:
        fail("manifest environment is invalid")
    metadata_path = bundle / "normalization-metadata.json"
    if metadata_path.is_file():
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("live_evidence_not_created") is not True:
            fail("normalization metadata does not prove that evidence was pre-existing")
        if metadata.get("release_sha") != args.release_sha or metadata.get("reconciliation_run_id") != args.run_id:
            fail("normalization metadata release/run binding mismatch")
    keys: dict[str, Ed25519PrivateKey] = {}
    for item in args.private_key:
        if "=" not in item:
            fail("--private-key must use ROLE=PATH")
        role, path = item.split("=", 1)
        if role not in ROLES or role in keys:
            fail(f"invalid or duplicate signing role: {role}")
        keys[role] = load_key(Path(path).resolve())
    if set(keys) != set(ROLES):
        fail("all four approval-role private keys are required")
    approvals = {a.get("role"): a for a in manifest.get("approvals", [])}
    if set(approvals) != set(ROLES) or len({a.get("subject") for a in approvals.values()}) != 4:
        fail("manifest must contain four distinct required approval subjects")
    canonical = canonical_manifest(manifest)
    manifest_digest = hashlib.sha256(canonical).hexdigest()
    args.signatures_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
    args.artifact_signatures_dir.mkdir(mode=0o750, parents=True, exist_ok=True)

    for role in ROLES:
        approval = approvals[role]
        subject = approval.get("subject")
        if approval.get("release_sha") != args.release_sha:
            fail(f"{role} approval release SHA mismatch")
        payload = canonical + b"\n" + role.encode() + b"\n" + subject.encode() + b"\n" + args.release_sha.encode()
        public = keys[role].public_key().public_bytes_raw()
        sidecar = {
            "role": role, "subject": subject, "release_sha": args.release_sha,
            "manifest_sha256": manifest_digest, "algorithm": "Ed25519",
            "public_key": b64(public), "signature": b64(keys[role].sign(payload)),
        }
        (args.signatures_dir / f"{role}.json").write_text(json.dumps(sidecar, indent=2) + "\n")

    for filename in FILES:
        path = bundle / filename
        if not path.is_file() or path.stat().st_size == 0:
            fail(f"normalized evidence file is missing or empty: {filename}")
        file_digest = sha256(path)
        envelope = json.dumps({
            "filename": filename, "sha256": file_digest,
            "release_sha": args.release_sha, "reconciliation_run_id": args.run_id,
        }, sort_keys=True, separators=(",", ":")).encode()
        for role in ROLES:
            out_dir = args.artifact_signatures_dir / role
            out_dir.mkdir(mode=0o750, parents=True, exist_ok=True)
            signature = keys[role].sign(envelope)
            (out_dir / f"{filename}.json").write_text(json.dumps({
                "filename": filename, "sha256": file_digest,
                "release_sha": args.release_sha, "reconciliation_run_id": args.run_id,
                "role": role, "algorithm": "Ed25519",
                "public_key": b64(keys[role].public_key().public_bytes_raw()),
                "signature": b64(signature),
            }, indent=2) + "\n")
    print(json.dumps({"status": "SIGNED_EXISTING_BUNDLE", "release_sha": args.release_sha, "run_id": args.run_id, "files": len(FILES), "roles": list(ROLES)}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"SIGNING FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
