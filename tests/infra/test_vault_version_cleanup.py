from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import scripts.infra.vault_version_cleanup as cleanup


class Response:
    def __init__(self, payload): self.payload = payload
    def __enter__(self): return self
    def __exit__(self, *_args): return False
    def read(self): return json.dumps(self.payload).encode()


def config(tmp_path: Path, apply: bool = False) -> cleanup.Config:
    return cleanup.Config(
        vault_addr="https://vault.test", vault_token="token", mount="secret",
        name="umoja/keycloak/evidence-publisher",
        state_file=tmp_path / "state.json", audit_file=tmp_path / "audit.jsonl",
        metrics_file=tmp_path / "metrics.prom", lease_file=tmp_path / "lease",
        retention_seconds=60, consumer_grace_seconds=60, timeout=1.0, apply=apply,
    )


def state(rotation_active=False):
    return {
        "current_version": 3, "previous_version": 2, "recovery_version": None,
        "rotation_active": rotation_active, "canary_active": False,
        "incident_hold": False, "legal_hold": False,
        "held_versions": [], "signed_manifest_versions": [], "consumer_last_fetch": {},
    }


OLD_VERSION_TIME = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat().replace("+00:00", "Z")


def metadata():
    old = OLD_VERSION_TIME
    return {"versions": {"1": {"created_time": old, "deletion_time": "", "destroyed": False}, "2": {"created_time": old, "deletion_time": "", "destroyed": False}, "3": {"created_time": old, "deletion_time": "", "destroyed": False}}}


def test_plan_excludes_current_and_previous(monkeypatch, tmp_path):
    cfg = config(tmp_path)
    cfg.state_file.write_text(json.dumps(state()))
    responses = iter([Response({"data": metadata()}), Response({"data": metadata()})])
    monkeypatch.setattr(cleanup.urllib.request, "urlopen", lambda *_a, **_k: next(responses))
    assert cleanup.run(cfg) == 0
    lines = [json.loads(line) for line in cfg.audit_file.read_text().splitlines()]
    assert lines[0]["candidate_versions"] == [1]
    assert lines[1]["deleted_versions"] == []
    assert "umoja_vault_cleanup_candidates_total 1" in cfg.metrics_file.read_text()


def test_active_rotation_denies_without_delete(monkeypatch, tmp_path):
    cfg = config(tmp_path)
    cfg.state_file.write_text(json.dumps(state(rotation_active=True)))
    monkeypatch.setattr(cleanup.urllib.request, "urlopen", lambda *_a, **_k: Response({"data": metadata()}))
    try:
        cleanup.run(cfg)
    except cleanup.CleanupDenied as exc:
        assert "rotation" in str(exc)
    else:
        raise AssertionError("active rotation must deny cleanup")


def test_invalid_state_denies(monkeypatch, tmp_path):
    cfg = config(tmp_path)
    cfg.state_file.write_text(json.dumps({"current_version": 1}))
    try:
        cleanup.run(cfg)
    except cleanup.CleanupDenied as exc:
        assert "missing fields" in str(exc)
    else:
        raise AssertionError("invalid state must deny cleanup")
