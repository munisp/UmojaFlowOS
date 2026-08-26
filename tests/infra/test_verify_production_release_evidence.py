from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[2] / "scripts" / "infra" / "verify_production_release_evidence.py"
spec = importlib.util.spec_from_file_location("release_evidence_verifier", SCRIPT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

RELEASE_SHA = "a" * 40


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_complete_bundle(root: Path) -> Path:
    artifacts = []
    for number in range(1, 10):
        evidence_id = f"E-{number:02d}"
        artifact_path = root / f"{evidence_id}.txt"
        artifact_path.write_text(f"evidence for {evidence_id}\n", encoding="utf-8")
        artifacts.append(
            {
                "evidence_id": evidence_id,
                "path": artifact_path.name,
                "sha256": digest(artifact_path),
                "run_id": f"run-{number}",
            }
        )
    approvals = [
        {
            "role": role,
            "subject": f"{role}-person",
            "release_sha": RELEASE_SHA,
            "approved_at": "2026-08-26T12:00:00Z",
        }
        for role in sorted(module.REQUIRED_APPROVAL_ROLES)
    ]
    manifest = {
        "release_sha": RELEASE_SHA,
        "environment": "staging",
        "created_at": "2026-08-26T12:00:00Z",
        "artifacts": artifacts,
        "approvals": approvals,
    }
    manifest_path = root / "release.json"
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    return manifest_path


def test_complete_bundle_passes(tmp_path: Path) -> None:
    manifest = write_complete_bundle(tmp_path)
    verified = module.verify_manifest(manifest, RELEASE_SHA)
    assert len(verified) == 9


def test_missing_evidence_fails_closed(tmp_path: Path) -> None:
    manifest = write_complete_bundle(tmp_path)
    document = json.loads(manifest.read_text())
    document["artifacts"] = document["artifacts"][:-1]
    manifest.write_text(json.dumps(document), encoding="utf-8")
    with pytest.raises(module.EvidenceValidationError, match="missing"):
        module.verify_manifest(manifest, RELEASE_SHA)


def test_hash_tampering_fails_closed(tmp_path: Path) -> None:
    manifest = write_complete_bundle(tmp_path)
    (tmp_path / "E-04.txt").write_text("tampered\n", encoding="utf-8")
    with pytest.raises(module.EvidenceValidationError, match="SHA-256 mismatch"):
        module.verify_manifest(manifest, RELEASE_SHA)


def test_approval_roles_must_be_unique(tmp_path: Path) -> None:
    manifest = write_complete_bundle(tmp_path)
    document = json.loads(manifest.read_text())
    document["approvals"][1]["role"] = document["approvals"][0]["role"]
    manifest.write_text(json.dumps(document), encoding="utf-8")
    with pytest.raises(module.EvidenceValidationError, match="duplicate approval role"):
        module.verify_manifest(manifest, RELEASE_SHA)


def test_approval_subjects_must_be_independent(tmp_path: Path) -> None:
    manifest = write_complete_bundle(tmp_path)
    document = json.loads(manifest.read_text())
    document["approvals"][1]["subject"] = document["approvals"][0]["subject"]
    manifest.write_text(json.dumps(document), encoding="utf-8")
    with pytest.raises(module.EvidenceValidationError, match="independent"):
        module.verify_manifest(manifest, RELEASE_SHA)


def test_release_sha_mismatch_fails_closed(tmp_path: Path) -> None:
    manifest = write_complete_bundle(tmp_path)
    with pytest.raises(module.EvidenceValidationError, match="does not match"):
        module.verify_manifest(manifest, "b" * 40)
