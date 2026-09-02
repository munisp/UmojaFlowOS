#!/usr/bin/env python3
"""Collect E-01 through E-09 evidence from explicitly approved staging runners.

This is an orchestrator, not an evidence generator. It never creates a PASS result
from a missing dependency, local fixture, or simulator. Each E-01..E-09 runner is
provided through E01_COMMAND .. E09_COMMAND and must write real evidence into the
provided per-item directory.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

AUTHORIZATION = "EXECUTE_APPROVED_STAGING_EVIDENCE_COLLECTION"
IDS = tuple(f"E-{i:02d}" for i in range(1, 10))
RUN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
SHA_RE = re.compile(r"^[a-f0-9]{40}$")


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fail(message: str) -> None:
    raise ValueError(message)


def validate_args(args: argparse.Namespace, repository: Path) -> None:
    if os.environ.get("STAGING_EVIDENCE_APPROVED") != AUTHORIZATION:
        fail("missing or invalid STAGING_EVIDENCE_APPROVED")
    if os.environ.get("UMOJA_ENV", "staging") != "staging":
        fail("collector only permits UMOJA_ENV=staging")
    if not SHA_RE.fullmatch(args.release_sha):
        fail("release_sha must be exactly 40 lowercase hexadecimal characters")
    if not RUN_RE.fullmatch(args.run_id):
        fail("run_id has invalid format")
    root = args.evidence_dir.resolve()
    repo = repository.resolve()
    if not root.is_absolute():
        fail("evidence_dir must be absolute")
    try:
        root.relative_to(repo)
    except ValueError:
        pass
    else:
        fail("evidence_dir must be outside the source repository")
    head = subprocess.run(
        ["git", "-C", str(repository), "rev-parse", "HEAD"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    if head != args.release_sha:
        fail(f"checked-out HEAD {head} does not match release_sha {args.release_sha}")
    dirty = subprocess.run(
        ["git", "-C", str(repository), "status", "--porcelain"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    if dirty:
        fail("worktree is dirty; live evidence must bind to a clean release")


def collect(args: argparse.Namespace) -> int:
    repository = Path(__file__).resolve().parents[2]
    validate_args(args, repository)
    root = args.evidence_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    metadata = {
        "release_sha": args.release_sha,
        "environment": "staging",
        "reconciliation_run_id": args.run_id,
        "created_at": utc_now(),
        "collector": "collect_all_production_evidence.py",
        "live_evidence": True,
    }
    (root / "collection-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    statuses: list[dict[str, Any]] = []

    for evidence_id in IDS:
        env_name = f"E{evidence_id[2:]}_COMMAND"
        item_dir = root / evidence_id
        item_dir.mkdir(parents=True, exist_ok=True)
        command_text = os.environ.get(env_name, "").strip()
        if not command_text:
            statuses.append({"evidence_id": evidence_id, "status": "BLOCKED", "reason": f"missing {env_name}"})
            continue
        try:
            command = shlex.split(command_text)
        except ValueError as exc:
            statuses.append({"evidence_id": evidence_id, "status": "BLOCKED", "reason": f"invalid command: {exc}"})
            continue
        child_env = os.environ.copy()
        child_env.update({
            "EVIDENCE_ID": evidence_id,
            "EVIDENCE_DIR": str(item_dir),
            "EVIDENCE_ENVIRONMENT": "staging",
            "RELEASE_SHA": args.release_sha,
            "RECONCILIATION_RUN_ID": args.run_id,
        })
        started = utc_now()
        result = subprocess.run(command, cwd=repository, env=child_env, capture_output=True, text=True, check=False)
        (item_dir / "runner.stdout.log").write_text(result.stdout)
        (item_dir / "runner.stderr.log").write_text(result.stderr)
        files = [p for p in sorted(item_dir.rglob("*")) if p.is_file() and p.name not in {"runner.stdout.log", "runner.stderr.log"} and p.stat().st_size > 0]
        row: dict[str, Any] = {
            "evidence_id": evidence_id,
            "started_at": started,
            "finished_at": utc_now(),
            "return_code": result.returncode,
            "evidence_dir": str(item_dir),
        }
        if result.returncode != 0:
            row.update(status="FAILED", reason="approved runner returned non-zero")
        elif not files:
            row.update(status="BLOCKED", reason="runner succeeded but emitted no non-empty artifact")
        else:
            row.update(status="READY_FOR_REVIEW", artifacts=[{
                "path": str(p.relative_to(root)),
                "sha256": sha256(p),
                "bytes": p.stat().st_size,
                "release_sha": args.release_sha,
                "reconciliation_run_id": args.run_id,
            } for p in files])
        statuses.append(row)

    (root / "collection-status.json").write_text(json.dumps(statuses, indent=2) + "\n")
    (root / "artifact-index.json").write_text(json.dumps({
        "release_sha": args.release_sha,
        "reconciliation_run_id": args.run_id,
        "generated_at": utc_now(),
        "artifacts": [artifact for row in statuses for artifact in row.get("artifacts", [])],
    }, indent=2) + "\n")
    failed = [row for row in statuses if row["status"] != "READY_FOR_REVIEW"]
    print(json.dumps({"status": "READY_FOR_REVIEW" if not failed else "NO-GO", "items": statuses}, indent=2))
    return 1 if failed else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--release-sha", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--evidence-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        return collect(args)
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        print(f"E-01 through E-09 collection: FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
