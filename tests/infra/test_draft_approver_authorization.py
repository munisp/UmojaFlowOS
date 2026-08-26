from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT = Path(__file__).parents[2] / "scripts" / "infra" / "draft_approver_authorization.py"
SHA = "0710d73eba23d41b74b70df28ac2eceb13d80f77"
ROLES = ("release_manager", "security_owner", "compliance_owner", "operations_owner")


def export_document(**overrides: object) -> dict:
    document = {
        "verification_status": "verified",
        "source": "enterprise-directory-test-export",
        "verified_by": "directory-auditor-test",
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "subjects": [
            {
                "role": role,
                "subject": f"directory-subject-{role}",
                "active": True,
                "subject_verified": True,
                "role_assignment_verified": True,
            }
            for role in ROLES
        ],
    }
    document.update(overrides)
    return document


def run(tmp_path: Path, document: dict) -> subprocess.CompletedProcess[str]:
    source = tmp_path / "directory.json"
    output = tmp_path / "authorization.json"
    source.write_text(json.dumps(document), encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--release-sha", SHA, "--directory-export", str(source), "--output", str(output)],
        capture_output=True,
        text=True,
    )


def test_verified_directory_export_creates_pending_draft(tmp_path: Path) -> None:
    result = run(tmp_path, export_document())
    assert result.returncode == 0, result.stderr
    draft = json.loads((tmp_path / "authorization.json").read_text())
    assert draft["authorization_status"] == "PENDING_OWNER_AUTHORIZATION"
    assert len(draft["owners"]) == 4
    assert len({owner["subject"] for owner in draft["owners"]}) == 4


def test_unverified_export_fails_closed(tmp_path: Path) -> None:
    result = run(tmp_path, export_document(verification_status="unverified"))
    assert result.returncode == 1
    assert "verification_status=verified" in result.stderr


def test_duplicate_subject_fails_closed(tmp_path: Path) -> None:
    document = export_document()
    document["subjects"][1]["subject"] = document["subjects"][0]["subject"]
    result = run(tmp_path, document)
    assert result.returncode == 1
    assert "must be distinct" in result.stderr
