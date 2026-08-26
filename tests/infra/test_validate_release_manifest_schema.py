from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[2] / "scripts" / "infra" / "validate_release_manifest_schema.py"
spec = importlib.util.spec_from_file_location("manifest_schema_validator", SCRIPT)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(module)


def valid_manifest() -> dict:
    return {
        "release_sha": "a" * 40,
        "environment": "staging",
        "created_at": "2026-08-26T12:00:00Z",
        "artifacts": [
            {"evidence_id": f"E-{i:02d}", "path": f"E-{i:02d}.json", "sha256": "b" * 64, "run_id": "run-1"}
            for i in range(1, 10)
        ],
        "approvals": [
            {"role": role, "subject": f"subject-{role}", "release_sha": "a" * 40, "approved_at": "2026-08-26T12:00:00Z"}
            for role in ("release_manager", "security_owner", "compliance_owner", "operations_owner")
        ],
    }


def validation_messages(document: dict, tmp_path: Path) -> str:
    manifest = tmp_path / "release.json"
    manifest.write_text(json.dumps(document), encoding="utf-8")
    schema = Path(__file__).parents[2] / "assurance/release_evidence_manifest.schema.json"
    validator = module.Draft202012Validator(json.loads(schema.read_text()), format_checker=module.FormatChecker())
    errors = sorted(validator.iter_errors(document), key=lambda error: list(error.absolute_path))
    return "\n".join(str(error.message) for error in errors)


def test_valid_manifest_schema_passes(tmp_path: Path) -> None:
    assert validation_messages(valid_manifest(), tmp_path) == ""


@pytest.mark.parametrize("location", ["root", "artifact", "approval"])
def test_custom_fields_are_rejected(location: str, tmp_path: Path) -> None:
    document = valid_manifest()
    if location == "root":
        document["custom_field"] = "not permitted"
    elif location == "artifact":
        document["artifacts"][0]["custom_field"] = "not permitted"
    else:
        document["approvals"][0]["custom_field"] = "not permitted"
    assert "Additional properties are not allowed" in validation_messages(document, tmp_path)
