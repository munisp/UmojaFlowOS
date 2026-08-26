from __future__ import annotations

import hashlib
import os
from pathlib import Path

os.environ.setdefault("INCIDENT_RESPONSE_IMPORT_ONLY", "1")

from simulators.retention_gateway.incident_response_service import incident_evidence_directory


def test_accepts_a_canonical_alertmanager_fingerprint_under_root(tmp_path: Path) -> None:
    incident_id, evidence = incident_evidence_directory(tmp_path, "alert-2026.08_critical", b"payload")

    assert incident_id == "alert-2026.08_critical"
    assert evidence.parent == tmp_path.resolve()


def test_replaces_path_traversal_or_absolute_fingerprint_with_authenticated_payload_digest(tmp_path: Path) -> None:
    payload = b'{"status":"firing"}'
    expected = hashlib.sha256(payload).hexdigest()

    for fingerprint in ("../../etc", "/tmp/escape", "alert/name", ".", "..", "", None):
        incident_id, evidence = incident_evidence_directory(tmp_path, fingerprint, payload)
        assert incident_id == expected
        assert evidence == tmp_path.resolve() / expected
        assert evidence.is_relative_to(tmp_path.resolve())
