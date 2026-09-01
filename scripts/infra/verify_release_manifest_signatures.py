#!/usr/bin/env python3
"""Verify a release evidence manifest and four detached Ed25519 approvals.

The manifest schema intentionally contains no private keys or signature blobs. Each
approval is stored as a detached JSON sidecar under --signatures-dir/<role>.json.
The sidecar signs the canonical JSON bytes of the schema-valid manifest and binds
its role, verified subject, release SHA, and manifest SHA-256.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import sys
from pathlib import Path
from typing import Any

try:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
except ImportError as exc:  # pragma: no cover
    raise SystemExit("cryptography package is required for Ed25519 verification") from exc

try:
    from jsonschema import Draft202012Validator, FormatChecker
except ImportError as exc:  # pragma: no cover
    raise SystemExit("jsonschema package is required for manifest schema validation") from exc

ROLES = (
    "release_manager",
    "security_owner",
    "compliance_owner",
    "operations_owner",
)
HEX40 = set("0123456789abcdef")
HEX64 = set("0123456789abcdef")
SIDECAR_FIELDS = {"role", "subject", "release_sha", "manifest_sha256", "algorithm", "public_key", "signature"}


class VerificationError(ValueError):
    pass


def canonical_manifest_bytes(manifest: dict[str, Any]) -> bytes:
    return json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def constant_time_equal_text(left: Any, right: Any) -> bool:
    """Compare fixed-format bindings without data-dependent early exit."""
    if not isinstance(left, str) or not isinstance(right, str):
        return False
    return hmac.compare_digest(left.encode("ascii", "strict"), right.encode("ascii", "strict"))


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VerificationError(f"cannot read {label}: {exc}") from exc
    if not isinstance(value, dict):
        raise VerificationError(f"{label} must contain a JSON object")
    return value


def validate_schema(manifest: dict[str, Any], schema_path: Path) -> None:
    schema = read_json(schema_path, "manifest schema")
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(manifest), key=lambda error: list(error.path))
    if errors:
        error = errors[0]
        location = ".".join(str(part) for part in error.path) or "$"
        raise VerificationError(f"manifest schema validation failed at {location}: {error.message}")


def decode_b64(value: Any, field: str, expected_length: int) -> bytes:
    if not isinstance(value, str) or not value:
        raise VerificationError(f"{field} must be a non-empty base64 string")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, TypeError) as exc:
        raise VerificationError(f"{field} is not valid base64") from exc
    if len(decoded) != expected_length:
        raise VerificationError(f"{field} must decode to {expected_length} bytes")
    return decoded


def verify(manifest_path: Path, schema_path: Path, signatures_dir: Path, expected_sha: str | None) -> None:
    manifest = read_json(manifest_path, "release manifest")
    validate_schema(manifest, schema_path)

    release_sha = manifest["release_sha"]
    if expected_sha is not None and not constant_time_equal_text(release_sha, expected_sha):
        raise VerificationError(f"manifest release_sha {release_sha} does not match expected {expected_sha}")
    if len(release_sha) != 40 or any(char not in HEX40 for char in release_sha):
        raise VerificationError("release_sha must be lowercase hexadecimal and 40 characters")

    canonical = canonical_manifest_bytes(manifest)
    manifest_digest = sha256_bytes(canonical)
    approvals = manifest["approvals"]
    if len(approvals) != 4:
        raise VerificationError("exactly four approvals are required for external sign-off")

    approval_by_role: dict[str, dict[str, Any]] = {}
    subjects: set[str] = set()
    for approval in approvals:
        role = approval["role"]
        subject = approval["subject"]
        if role not in ROLES:
            raise VerificationError(f"invalid approval role: {role}")
        if role in approval_by_role:
            raise VerificationError(f"duplicate approval role: {role}")
        if subject in subjects:
            raise VerificationError("approval subjects must be distinct across roles")
        if not constant_time_equal_text(approval["release_sha"], release_sha):
            raise VerificationError(f"{role} approval is not bound to manifest release_sha")
        approval_by_role[role] = approval
        subjects.add(subject)

    missing = [role for role in ROLES if role not in approval_by_role]
    if missing:
        raise VerificationError(f"required approval roles are missing: {', '.join(missing)}")

    for role in ROLES:
        sidecar_path = signatures_dir / f"{role}.json"
        sidecar = read_json(sidecar_path, f"{role} signature sidecar")
        unknown = set(sidecar) - SIDECAR_FIELDS
        if unknown:
            raise VerificationError(f"{role} sidecar contains unsupported fields: {', '.join(sorted(unknown))}")
        required = SIDECAR_FIELDS
        missing_fields = sorted(required - set(sidecar))
        if missing_fields:
            raise VerificationError(f"{role} sidecar is missing: {', '.join(missing_fields)}")
        if sidecar["role"] != role:
            raise VerificationError(f"{role} sidecar role does not match its filename")
        approval = approval_by_role[role]
        if sidecar["subject"] != approval["subject"]:
            raise VerificationError(f"{role} sidecar subject does not match manifest approval subject")
        if not constant_time_equal_text(sidecar["release_sha"], release_sha):
            raise VerificationError(f"{role} sidecar release_sha does not match manifest")
        if not constant_time_equal_text(sidecar["manifest_sha256"], manifest_digest):
            raise VerificationError(f"{role} sidecar manifest_sha256 does not match canonical manifest")
        if sidecar["algorithm"] != "Ed25519":
            raise VerificationError(f"{role} sidecar algorithm must be Ed25519")
        public_key = decode_b64(sidecar["public_key"], f"{role}.public_key", 32)
        signature = decode_b64(sidecar["signature"], f"{role}.signature", 64)
        signed_payload = canonical + b"\n" + role.encode("utf-8") + b"\n" + sidecar["subject"].encode("utf-8") + b"\n" + release_sha.encode("ascii")
        try:
            Ed25519PublicKey.from_public_bytes(public_key).verify(signature, signed_payload)
        except InvalidSignature as exc:
            raise VerificationError(f"{role} Ed25519 signature verification failed") from exc


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify schema-valid release manifest and detached Ed25519 approvals")
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--schema", required=True, type=Path)
    parser.add_argument("--signatures-dir", required=True, type=Path)
    parser.add_argument("--expected-sha", help="Optional expected immutable release SHA")
    args = parser.parse_args()
    try:
        verify(args.manifest, args.schema, args.signatures_dir, args.expected_sha)
    except VerificationError as exc:
        print(f"release manifest signature verification: FAILED: {exc}", file=sys.stderr)
        return 1
    print("release manifest signature verification: PASSED (schema, exact roles, distinct subjects, shared SHA, Ed25519 signatures)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
