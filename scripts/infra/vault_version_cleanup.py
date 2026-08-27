#!/usr/bin/env python3
"""Fail-closed Vault KV v2 version cleanup.

Default mode is plan-only. `--apply` performs KV v2 soft deletion only; routine
cleanup never invokes the destroy endpoint. All uncertain state is a DENY.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Config:
    vault_addr: str
    vault_token: str
    mount: str
    name: str
    state_file: Path
    audit_file: Path
    metrics_file: Path
    lease_file: Path
    retention_seconds: int
    consumer_grace_seconds: int
    timeout: float
    apply: bool


class CleanupDenied(RuntimeError):
    pass


def parse_time(value: str) -> datetime:
    if not isinstance(value, str):
        raise CleanupDenied("timestamp is not a string")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise CleanupDenied("timestamp is not RFC3339") from exc
    if parsed.tzinfo is None:
        raise CleanupDenied("timestamp has no timezone")
    return parsed.astimezone(timezone.utc)


def canonical_digest(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CleanupDenied(f"cannot read JSON state: {path}") from exc
    if not isinstance(value, dict):
        raise CleanupDenied("state must be a JSON object")
    return value


def validate_state(state: dict[str, Any]) -> dict[str, Any]:
    required = {
        "current_version", "previous_version", "recovery_version", "rotation_active",
        "canary_active", "incident_hold", "legal_hold", "held_versions",
        "signed_manifest_versions", "consumer_last_fetch",
    }
    missing = required - set(state)
    if missing:
        raise CleanupDenied(f"state is missing fields: {sorted(missing)}")
    for key in ("current_version", "previous_version", "recovery_version"):
        value = state[key]
        if value is not None and (not isinstance(value, int) or value < 1):
            raise CleanupDenied(f"{key} must be null or a positive integer")
    for key in ("rotation_active", "canary_active", "incident_hold", "legal_hold"):
        if not isinstance(state[key], bool):
            raise CleanupDenied(f"{key} must be boolean")
    for key in ("held_versions", "signed_manifest_versions"):
        if not isinstance(state[key], list) or any(not isinstance(x, int) or x < 1 for x in state[key]):
            raise CleanupDenied(f"{key} must be a list of positive integers")
    if not isinstance(state["consumer_last_fetch"], dict):
        raise CleanupDenied("consumer_last_fetch must be an object")
    for version, timestamp in state["consumer_last_fetch"].items():
        if not version.isdigit() or int(version) < 1:
            raise CleanupDenied("consumer_last_fetch contains an invalid version")
        parse_time(timestamp)
    return state


def vault_request(cfg: Config, method: str, suffix: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{cfg.vault_addr.rstrip('/')}/v1/{suffix.lstrip('/')}"
    data = None if body is None else json.dumps(body, separators=(",", ":")).encode()
    request = urllib.request.Request(
        url,
        data=data,
        headers={"X-Vault-Token": cfg.vault_token, "Content-Type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=cfg.timeout) as response:
            parsed = json.loads(response.read())
    except (OSError, urllib.error.HTTPError, json.JSONDecodeError) as exc:
        raise CleanupDenied(f"Vault {method} request failed") from exc
    if not isinstance(parsed, dict):
        raise CleanupDenied("Vault response is not an object")
    return parsed


def metadata(cfg: Config) -> dict[str, Any]:
    result = vault_request(cfg, "GET", f"{cfg.mount}/metadata/{cfg.name}")
    data = result.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("versions"), dict):
        raise CleanupDenied("Vault metadata has no versions object")
    for version, item in data["versions"].items():
        if not version.isdigit() or not isinstance(item, dict) or "created_time" not in item:
            raise CleanupDenied("Vault metadata contains an invalid version entry")
        parse_time(item["created_time"])
        if item.get("destroyed") is True:
            continue
        if item.get("deletion_time") not in (None, ""):
            continue
    return data


def load_consistent_state(cfg: Config) -> tuple[dict[str, Any], dict[str, Any], str]:
    state = validate_state(read_json(cfg.state_file))
    meta = metadata(cfg)
    digest = canonical_digest({"state": state, "metadata": meta})
    return state, meta, digest


def protected_versions(state: dict[str, Any]) -> set[int]:
    result = {x for x in (state["current_version"], state["previous_version"], state["recovery_version"]) if x is not None}
    result.update(state["held_versions"])
    result.update(state["signed_manifest_versions"])
    return result


def candidates(cfg: Config, state: dict[str, Any], meta: dict[str, Any], now: datetime) -> tuple[list[int], dict[str, list[int]]]:
    if state["rotation_active"] or state["canary_active"]:
        raise CleanupDenied("rotation or canary is active")
    if state["incident_hold"] or state["legal_hold"]:
        raise CleanupDenied("incident or legal hold is active")
    protected = protected_versions(state)
    excluded: dict[str, list[int]] = {"protected": [], "young": [], "recently_fetched": [], "already_deleted": []}
    selected: list[int] = []
    for raw_version, item in meta["versions"].items():
        version = int(raw_version)
        if item.get("destroyed") is True or item.get("deletion_time") not in (None, ""):
            excluded["already_deleted"].append(version); continue
        if version in protected:
            excluded["protected"].append(version); continue
        created = parse_time(item["created_time"])
        if now - created < timedelta(seconds=cfg.retention_seconds):
            excluded["young"].append(version); continue
        fetched = state["consumer_last_fetch"].get(str(version))
        if fetched and now - parse_time(fetched) < timedelta(seconds=cfg.consumer_grace_seconds):
            excluded["recently_fetched"].append(version); continue
        selected.append(version)
    return sorted(selected), excluded


def append_audit(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(record, sort_keys=True, separators=(",", ":"))
    with path.open("a", encoding="utf-8") as handle:
        handle.write(encoded + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def write_metrics(path: Path, values: dict[str, int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf-8")
    try:
        handle.write("# TYPE umoja_vault_cleanup_runs_total counter\n")
        handle.write(f"umoja_vault_cleanup_runs_total{{decision=\"{values['decision']}\"}} {values['runs']}\n")
        handle.write(f"umoja_vault_cleanup_candidates_total {values['candidates']}\n")
        handle.write(f"umoja_vault_cleanup_deleted_versions_total {values['deleted']}\n")
        handle.write(f"umoja_vault_cleanup_failures_total {values['failures']}\n")
        handle.flush(); os.fsync(handle.fileno())
        os.replace(handle.name, path)
    finally:
        try: os.unlink(handle.name)
        except FileNotFoundError: pass


def run(cfg: Config) -> int:
    cfg.lease_file.parent.mkdir(parents=True, exist_ok=True)
    with cfg.lease_file.open("a+", encoding="utf-8") as lease:
        try:
            fcntl.flock(lease.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise CleanupDenied("cleanup lease unavailable")
        state, before_meta, before_digest = load_consistent_state(cfg)
        now = datetime.now(timezone.utc)
        selected, excluded = candidates(cfg, state, before_meta, now)
        decision = "PLAN" if not cfg.apply else "ALLOW"
        base = {
            "event_type": "vault_version_cleanup",
            "path": f"{cfg.mount}/{cfg.name}",
            "cleanup_run_id": os.getenv("CLEANUP_RUN_ID", f"cleanup-{now.strftime('%Y%m%dT%H%M%SZ')}"),
            "holder_identity": os.getenv("CLEANUP_IDENTITY", "vault-version-cleanup"),
            "policy_version": os.getenv("CLEANUP_POLICY_VERSION", "1"),
            "candidate_versions": selected,
            "excluded": excluded,
            "decision": decision,
            "metadata_digest_before": before_digest,
            "completed_at": now.isoformat().replace("+00:00", "Z"),
        }
        append_audit(cfg.audit_file, base)
        state_after, meta_after, after_digest = load_consistent_state(cfg)
        if canonical_digest({"state": state_after, "metadata": meta_after}) != before_digest:
            raise CleanupDenied("state changed before delete")
        deleted: list[int] = []
        if cfg.apply and selected:
            vault_request(cfg, "POST", f"{cfg.mount}/delete/{cfg.name}", {"versions": selected})
            verify_meta = metadata(cfg)
            for version in selected:
                item = verify_meta["versions"].get(str(version))
                if not isinstance(item, dict) or item.get("deletion_time") in (None, ""):
                    raise CleanupDenied("post-delete verification failed")
            deleted = selected
        base.update({"deleted_versions": deleted, "metadata_digest_after": after_digest if not deleted else canonical_digest(metadata(cfg)), "decision": decision})
        append_audit(cfg.audit_file, base)
        write_metrics(cfg.metrics_file, {"decision": decision.lower(), "runs": 1, "candidates": len(selected), "deleted": len(deleted), "failures": 0})
        return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    cfg = Config(
        vault_addr=os.environ["VAULT_ADDR"], vault_token=os.environ["VAULT_TOKEN"],
        mount=os.getenv("VAULT_KV_MOUNT", "secret").strip("/"),
        name=os.getenv("VAULT_KV_NAME", "umoja/keycloak/evidence-publisher").strip("/"),
        state_file=Path(os.environ["VAULT_CLEANUP_STATE_FILE"]),
        audit_file=Path(os.environ["VAULT_CLEANUP_AUDIT_FILE"]),
        metrics_file=Path(os.environ["VAULT_CLEANUP_METRICS_FILE"]),
        lease_file=Path(os.environ["VAULT_CLEANUP_LEASE_FILE"]),
        retention_seconds=int(os.getenv("VAULT_CLEANUP_RETENTION_SECONDS", "86400")),
        consumer_grace_seconds=int(os.getenv("VAULT_CLEANUP_CONSUMER_GRACE_SECONDS", "900")),
        timeout=float(os.getenv("VAULT_HTTP_TIMEOUT_SECONDS", "5")), apply=args.apply,
    )
    if min(cfg.retention_seconds, cfg.consumer_grace_seconds) < 0:
        raise SystemExit("retention values must be nonnegative")
    try:
        return run(cfg)
    except CleanupDenied as exc:
        print(f"CLEANUP_DENIED: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
