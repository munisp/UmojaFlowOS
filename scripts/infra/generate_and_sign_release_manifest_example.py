#!/usr/bin/env python3
"""Generate detached four-role Ed25519 sidecars for an authorized manifest.

Private keys are supplied by file paths and are never written to the output
bundle. This script is an example for a controlled signing workstation; it does
not create regulatory approval records or replace independent authorization.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from jsonschema import Draft202012Validator, FormatChecker

ROLES = (
    "release_manager",
    "security_owner",
    "compliance_owner",
    "operations_owner",
)


def canonical(value: dict[str, Any]) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def load_private_key(path: Path) -> Ed25519PrivateKey:
    key = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError(f"{path} is not an Ed25519 private key")
    return key


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--schema", required=True, type=Path)
    parser.add_argument("--signatures-dir", required=True, type=Path)
    parser.add_argument("--key-dir", required=True, type=Path)
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    schema = json.loads(args.schema.read_text(encoding="utf-8"))
    errors = sorted(
        Draft202012Validator(schema, format_checker=FormatChecker()).iter_errors(manifest),
        key=lambda error: list(error.path),
    )
    if errors:
        raise SystemExit(f"manifest schema validation failed: {errors[0].message}")

    release_sha = manifest["release_sha"]
    manifest_bytes = canonical(manifest)
    manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()
    approvals = {entry["role"]: entry for entry in manifest["approvals"]}
    if set(approvals) != set(ROLES):
        raise SystemExit("manifest must contain exactly the four required approval roles")
    if len({entry["subject"] for entry in approvals.values()}) != 4:
        raise SystemExit("approval subjects must be distinct")
    if any(entry["release_sha"] != release_sha for entry in approvals.values()):
        raise SystemExit("all approvals must bind to manifest release_sha")

    args.signatures_dir.mkdir(parents=True, exist_ok=True)
    for role in ROLES:
        key_path = args.key_dir / f"{role}.pem"
        private_key = load_private_key(key_path)
        public_key = private_key.public_key().public_bytes(
            serialization.Encoding.Raw,
            serialization.PublicFormat.Raw,
        )
        subject = approvals[role]["subject"]
        payload = (
            manifest_bytes
            + b"\n"
            + role.encode("utf-8")
            + b"\n"
            + subject.encode("utf-8")
            + b"\n"
            + release_sha.encode("ascii")
        )
        sidecar = {
            "role": role,
            "subject": subject,
            "release_sha": release_sha,
            "manifest_sha256": manifest_sha256,
            "algorithm": "Ed25519",
            "public_key": base64.b64encode(public_key).decode("ascii"),
            "signature": base64.b64encode(private_key.sign(payload)).decode("ascii"),
        }
        output = args.signatures_dir / f"{role}.json"
        output.write_text(json.dumps(sidecar, indent=2) + "\n", encoding="utf-8")
        output.chmod(0o644)
        print(f"wrote {output}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
