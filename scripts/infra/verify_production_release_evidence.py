#!/usr/bin/env python3
"""Fail-closed verifier for UmojaFlowOS production release evidence.

The verifier deliberately does not create evidence, contact production systems, or
infer success from a file name. It validates a supplied manifest, SHA-256 digests,
release-SHA binding, environment, required evidence IDs, and independent approval
roles. A non-zero exit status is a release gate failure.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REQUIRED_EVIDENCE_IDS = tuple(f"E-{number:02d}" for number in range(1, 10))
REQUIRED_APPROVAL_ROLES = {
    "release_manager",
    "security_owner",
    "compliance_owner",
    "operations_owner",
}
SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
GIT_SHA_RE = re.compile(r"^[a-f0-9]{40}$")


class EvidenceValidationError(ValueError):
    """Raised when a release evidence bundle is incomplete or inconsistent."""


@dataclass(frozen=True)
class VerifiedArtifact:
    evidence_id: str
    path: Path
    sha256: str


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def parse_iso8601(value: str, field: str) -> None:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError) as error:
        raise EvidenceValidationError(f"{field} must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None:
        raise EvidenceValidationError(f"{field} must include a timezone")


def safe_artifact_path(bundle_root: Path, declared_path: str) -> Path:
    if not isinstance(declared_path, str) or not declared_path:
        raise EvidenceValidationError("artifact path must be a non-empty relative path")
    candidate = (bundle_root / declared_path).resolve()
    try:
        candidate.relative_to(bundle_root.resolve())
    except ValueError as error:
        raise EvidenceValidationError(f"artifact path escapes bundle root: {declared_path}") from error
    return candidate


def expected_git_sha(repo: Path) -> str:
    status = subprocess.run(
        ["git", "-C", str(repo), "status", "--porcelain"],
        check=True,
        capture_output=True,
        text=True,
    )
    if status.stdout.strip():
        raise EvidenceValidationError("repository is dirty; evidence must bind to an immutable clean release revision")
    result = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def verify_manifest(manifest_path: Path, expected_sha: str | None = None) -> list[VerifiedArtifact]:
    try:
        document: dict[str, Any] = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise EvidenceValidationError(f"cannot read JSON manifest: {error}") from error

    release_sha = document.get("release_sha")
    if not isinstance(release_sha, str) or not GIT_SHA_RE.fullmatch(release_sha):
        raise EvidenceValidationError("release_sha must be a lowercase 40-character Git SHA")
    if expected_sha and release_sha != expected_sha:
        raise EvidenceValidationError(
            f"release_sha {release_sha} does not match expected immutable revision {expected_sha}"
        )

    environment = document.get("environment")
    if environment not in {"staging", "production"}:
        raise EvidenceValidationError("environment must be staging or production")
    parse_iso8601(document.get("created_at"), "created_at")

    worm = document.get("worm")
    if not isinstance(worm, dict):
        raise EvidenceValidationError("worm binding must be an object")
    bucket = worm.get("bucket")
    prefix = worm.get("object_key_prefix")
    lock_mode = worm.get("object_lock_mode")
    retain_until = worm.get("retain_until")
    if not isinstance(bucket, str) or not re.fullmatch(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", bucket):
        raise EvidenceValidationError("worm.bucket must be a valid non-empty lowercase bucket name")
    if not isinstance(prefix, str) or not prefix or prefix.startswith("/") or prefix.endswith("/") or ".." in Path(prefix).parts:
        raise EvidenceValidationError("worm.object_key_prefix must be a safe relative prefix")
    if lock_mode not in {"COMPLIANCE", "GOVERNANCE"}:
        raise EvidenceValidationError("worm.object_lock_mode must be COMPLIANCE or GOVERNANCE")
    parse_iso8601(retain_until, "worm.retain_until")
    if datetime.fromisoformat(retain_until.replace("Z", "+00:00")) <= datetime.now(timezone.utc):
        raise EvidenceValidationError("worm.retain_until must be in the future")

    reconciliation = document.get("reconciliation")
    if not isinstance(reconciliation, dict) or not re.fullmatch(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$", str(reconciliation.get("run_id", ""))):
        raise EvidenceValidationError("reconciliation.run_id must be a valid non-empty run identifier")

    artifacts = document.get("artifacts")
    if not isinstance(artifacts, list):
        raise EvidenceValidationError("artifacts must be a list")

    bundle_root = manifest_path.parent
    verified: list[VerifiedArtifact] = []
    seen_ids: set[str] = set()
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            raise EvidenceValidationError("each artifact must be an object")
        evidence_id = artifact.get("evidence_id")
        declared_path = artifact.get("path")
        declared_sha = artifact.get("sha256")
        run_id = artifact.get("run_id")
        if evidence_id not in REQUIRED_EVIDENCE_IDS:
            raise EvidenceValidationError(f"unexpected or invalid evidence_id: {evidence_id}")
        if evidence_id in seen_ids:
            raise EvidenceValidationError(f"duplicate evidence_id: {evidence_id}")
        if not isinstance(run_id, str) or not run_id.strip():
            raise EvidenceValidationError(f"{evidence_id} requires a non-empty run_id")
        if not isinstance(declared_sha, str) or not SHA256_RE.fullmatch(declared_sha):
            raise EvidenceValidationError(f"{evidence_id} requires a lowercase SHA-256 digest")
        artifact_path = safe_artifact_path(bundle_root, declared_path)
        if not artifact_path.is_file() or artifact_path.stat().st_size == 0:
            raise EvidenceValidationError(f"{evidence_id} artifact is missing or empty: {declared_path}")
        actual_sha = sha256_file(artifact_path)
        if actual_sha != declared_sha:
            raise EvidenceValidationError(f"{evidence_id} SHA-256 mismatch for {declared_path}")
        seen_ids.add(evidence_id)
        verified.append(VerifiedArtifact(evidence_id, artifact_path, actual_sha))

    missing = sorted(set(REQUIRED_EVIDENCE_IDS) - seen_ids)
    if missing:
        raise EvidenceValidationError(f"required evidence artifacts are missing: {', '.join(missing)}")

    approvals = document.get("approvals")
    if not isinstance(approvals, list):
        raise EvidenceValidationError("approvals must be a list")
    approved_roles: set[str] = set()
    approval_subjects: set[str] = set()
    for approval in approvals:
        if not isinstance(approval, dict):
            raise EvidenceValidationError("each approval must be an object")
        role = approval.get("role")
        subject = approval.get("subject")
        approval_sha = approval.get("release_sha")
        if role not in REQUIRED_APPROVAL_ROLES:
            raise EvidenceValidationError(f"invalid approval role: {role}")
        if role in approved_roles:
            raise EvidenceValidationError(f"duplicate approval role: {role}")
        if not isinstance(subject, str) or not subject.strip():
            raise EvidenceValidationError(f"{role} approval requires a subject")
        if subject in approval_subjects:
            raise EvidenceValidationError("approval subjects must be independent across required roles")
        if approval_sha != release_sha:
            raise EvidenceValidationError(f"{role} approval is not bound to manifest release_sha")
        parse_iso8601(approval.get("approved_at"), f"{role}.approved_at")
        approved_roles.add(role)
        approval_subjects.add(subject)

    missing_roles = sorted(REQUIRED_APPROVAL_ROLES - approved_roles)
    if missing_roles:
        raise EvidenceValidationError(f"required independent approvals are missing: {', '.join(missing_roles)}")
    return verified


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a production release evidence manifest.")
    parser.add_argument("--manifest", required=True, type=Path, help="JSON release evidence manifest")
    parser.add_argument(
        "--expected-sha",
        help="Expected immutable 40-character release SHA; use the checked-out revision in CI",
    )
    parser.add_argument(
        "--repo",
        type=Path,
        help="Repository whose HEAD must equal release_sha; mutually exclusive with --expected-sha",
    )
    args = parser.parse_args()
    if args.expected_sha and args.repo:
        parser.error("--expected-sha and --repo are mutually exclusive")
    expected_sha = args.expected_sha
    if args.repo:
        expected_sha = expected_git_sha(args.repo)
    if expected_sha and not GIT_SHA_RE.fullmatch(expected_sha):
        parser.error("expected SHA must be a lowercase 40-character Git SHA")

    try:
        verified = verify_manifest(args.manifest, expected_sha)
    except EvidenceValidationError as error:
        print(f"release evidence verification: FAILED: {error}", file=sys.stderr)
        return 1
    except subprocess.CalledProcessError as error:
        print(f"release evidence verification: FAILED: cannot resolve repository SHA: {error}", file=sys.stderr)
        return 1

    print(
        "release evidence verification: PASSED "
        f"({len(verified)} required artifacts, immutable release binding, independent approvals)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
