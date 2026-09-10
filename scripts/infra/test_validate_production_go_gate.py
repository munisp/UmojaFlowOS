#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("verify_production_release_evidence.py")
SPEC = importlib.util.spec_from_file_location("release_evidence", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules["release_evidence"] = MODULE
SPEC.loader.exec_module(MODULE)


class ProductionEvidenceVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.release_sha = "a" * 40
        self.run_id = "staging-run-20260902-001"
        self.manifest_path = self.root / "release_evidence_manifest.json"
        self._write_bundle()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _write_bundle(self) -> None:
        artifacts = []
        for number in range(1, 10):
            evidence_id = f"E-{number:02d}"
            path = self.root / f"{evidence_id}.json"
            path.write_text(
                json.dumps({
                    "evidence_id": evidence_id,
                    "provenance": "authorized_staging",
                    "live_cluster_evidence": True,
                    "status": "PASS",
                }),
                encoding="utf-8",
            )
            artifacts.append({
                "evidence_id": evidence_id,
                "path": path.name,
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "run_id": self.run_id,
            })
        self.manifest_path.write_text(json.dumps({
            "release_sha": self.release_sha,
            "environment": "staging",
            "created_at": "2026-09-02T12:00:00Z",
            "artifacts": artifacts,
            "approvals": [
                {
                    "role": role,
                    "subject": f"{role}-subject",
                    "release_sha": self.release_sha,
                    "approved_at": "2026-09-02T12:01:00Z",
                }
                for role in MODULE.REQUIRED_APPROVAL_ROLES
            ],
            "worm": {
                "bucket": "umoja-release-evidence",
                "object_key_prefix": "releases/test",
                "object_lock_mode": "COMPLIANCE",
                "retain_until": (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
            },
            "reconciliation": {"run_id": self.run_id},
        }, indent=2), encoding="utf-8")

    def _manifest(self) -> dict:
        return json.loads(self.manifest_path.read_text(encoding="utf-8"))

    def _assert_rejected(self, mutate) -> None:
        manifest = self._manifest()
        mutate(manifest)
        self.manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaises(MODULE.EvidenceValidationError):
            MODULE.verify_manifest(self.manifest_path, self.release_sha, "production")

    def test_valid_complete_bundle(self) -> None:
        verified = MODULE.verify_manifest(self.manifest_path, self.release_sha, "production")
        self.assertEqual(len(verified), 9)

    def test_missing_evidence_id_rejected(self) -> None:
        self._assert_rejected(lambda m: m["artifacts"].pop())

    def test_duplicate_evidence_id_rejected(self) -> None:
        self._assert_rejected(lambda m: m["artifacts"].__setitem__(1, m["artifacts"][0]))

    def test_digest_tampering_rejected(self) -> None:
        self._assert_rejected(lambda m: m["artifacts"][0].__setitem__("sha256", "0" * 64))

    def test_path_traversal_rejected(self) -> None:
        self._assert_rejected(lambda m: m["artifacts"][0].__setitem__("path", "../outside.json"))

    def test_expired_worm_retention_rejected(self) -> None:
        self._assert_rejected(lambda m: m["worm"].__setitem__("retain_until", "2020-01-01T00:00:00Z"))

    def test_local_fixture_rejected_in_production(self) -> None:
        self._assert_rejected(lambda m: m.update({"provenance": "local_fixture", "live_cluster_evidence": False}))

    def test_duplicate_approval_role_rejected(self) -> None:
        self._assert_rejected(lambda m: m["approvals"].__setitem__(1, m["approvals"][0]))

    def test_missing_approval_role_rejected(self) -> None:
        self._assert_rejected(lambda m: m["approvals"].pop())

    def test_release_sha_binding_rejected(self) -> None:
        self._assert_rejected(lambda m: m.__setitem__("release_sha", "b" * 40))


if __name__ == "__main__":
    unittest.main(verbosity=2)
