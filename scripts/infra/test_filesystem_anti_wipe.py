"""Anti-wipe guardian: hash-chain integrity, deletion/modification/truncation
detection, append-only growth tolerance, audit-log tamper detection."""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import filesystem_anti_wipe as aw  # noqa: E402


@pytest.fixture()
def env(tmp_path: Path):
    root = tmp_path / "repo"
    (root / "artifacts/evidence").mkdir(parents=True)
    (root / "logs/audit").mkdir(parents=True)
    (root / "artifacts/evidence/e1.json").write_text('{"ok": true}')
    (root / "artifacts/evidence/e2.json").write_text('{"ok": 2}')
    (root / "logs/audit/a.jsonl").write_text('{"line": 1}\n')
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps({"protected": [
        {"path": "artifacts/evidence", "class": "compliance-evidence", "immutable": True, "retention_days": 2555},
        {"path": "logs/audit", "class": "audit-log", "append_only": True, "retention_days": 2555},
    ]}))
    manifest = tmp_path / "manifest.json"
    log = tmp_path / "audit.jsonl"
    config = aw.Config.load(config_path)
    assert aw.cmd_build(root, config, manifest, log) == 0
    return root, config, manifest, log


def test_verify_clean_tree_passes(env):
    root, config, manifest, log = env
    assert aw.cmd_verify(root, config, manifest, log) == 0


def test_deleted_file_detected_fail_closed(env):
    root, config, manifest, log = env
    (root / "artifacts/evidence/e1.json").unlink()
    assert aw.cmd_verify(root, config, manifest, log) == 1
    violations = aw.verify(root, config, manifest)
    assert any("MISSING" in v and "e1.json" in v for v in violations)


def test_modified_evidence_detected(env):
    root, config, manifest, log = env
    (root / "artifacts/evidence/e2.json").write_text('{"ok": "tampered"}')
    violations = aw.verify(root, config, manifest)
    assert any("MODIFIED" in v and "e2.json" in v for v in violations)


def test_append_only_growth_tolerated_but_truncation_detected(env):
    root, config, manifest, log = env
    audit_file = root / "logs/audit/a.jsonl"
    audit_file.write_text(audit_file.read_text() + '{"line": 2}\n')
    assert aw.verify(root, config, manifest) == []  # growth is legal
    audit_file.write_text('{"line": 1')  # truncated
    violations = aw.verify(root, config, manifest)
    assert any("TRUNCATED" in v for v in violations)


def test_unrecorded_file_in_immutable_class_detected(env):
    root, config, manifest, log = env
    (root / "artifacts/evidence/sneaky.json").write_text("{}")
    violations = aw.verify(root, config, manifest)
    assert any("UNRECORDED" in v and "sneaky.json" in v for v in violations)


def test_chain_root_changes_on_any_entry_change(env):
    root, config, manifest, log = env
    doc = json.loads(manifest.read_text())
    original_root = doc["root"]
    doc["entries"][0]["sha256"] = "0" * 64
    assert aw.chain_root(doc["entries"]) != original_root


def test_audit_log_is_hash_chained_and_tamper_evident(env):
    root, config, manifest, log = env
    aw.cmd_verify(root, config, manifest, log)
    aw.cmd_verify(root, config, manifest, log)
    assert aw.cmd_audit(log) == 0
    lines = log.read_text().splitlines()
    row = json.loads(lines[1])
    row["violations"] = 99  # rewrite history
    lines[1] = json.dumps(row)
    log.write_text("\n".join(lines) + "\n")
    assert aw.cmd_audit(log) == 1


def test_enforce_strips_write_bits(env, monkeypatch):
    root, config, manifest, log = env
    monkeypatch.setattr(aw, "_chattr_supported", lambda: False)
    notes = aw.enforce(root, config)
    assert notes
    evidence = root / "artifacts/evidence/e1.json"
    assert not (evidence.stat().st_mode & 0o222), "evidence must be read-only after enforce"
