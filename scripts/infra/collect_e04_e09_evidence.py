#!/usr/bin/env python3
"""Collect E-04 through E-09 evidence from explicitly authorized staging runners.

The collector is an orchestrator, not an evidence generator. It never invents a
pass, contacts a provider implicitly, prints secrets, or copies local fixtures into
staging evidence. Each runner is supplied through an environment variable:
E04_COMMAND ... E09_COMMAND. Commands execute only after an explicit authorization
marker and an immutable clean release check.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

EVIDENCE_IDS = tuple(f"E-{number:02d}" for number in range(4, 10))
COMMAND_ENV = {evidence_id: f"E{evidence_id[2:]}_COMMAND" for evidence_id in EVIDENCE_IDS}
AUTHORIZATION = "EXECUTE_APPROVED_STAGING_EVIDENCE_COLLECTION"


class CollectionError(ValueError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(block)
    return sha.hexdigest()


def require_safe_output(root: Path, repository: Path) -> None:
    if not root.is_absolute():
        raise CollectionError("evidence directory must be an absolute approved external path")
    resolved = root.resolve()
    repo = repository.resolve()
    try:
        resolved.relative_to(repo)
    except ValueError:
        return
    raise CollectionError("evidence directory must not be inside the source repository")


def verify_release(repository: Path, release_sha: str) -> None:
    head = subprocess.run(["git", "-C", str(repository), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    if head != release_sha:
        raise CollectionError(f"checked-out HEAD {head} does not match requested release SHA {release_sha}")
    dirty = subprocess.run(["git", "-C", str(repository), "status", "--porcelain"], capture_output=True, text=True, check=True).stdout.strip()
    if dirty:
        raise CollectionError("repository worktree is dirty; evidence must bind to an immutable clean revision")


def nonempty_files(directory: Path) -> list[Path]:
    return sorted(path for path in directory.rglob("*") if path.is_file() and path.stat().st_size > 0)


def collect(args: argparse.Namespace) -> int:
    repository = Path(__file__).resolve().parents[2]
    release_sha = args.release_sha
    if len(release_sha) != 40 or any(char not in "0123456789abcdef" for char in release_sha):
        raise CollectionError("release SHA must be a lowercase 40-character Git SHA")
    evidence_root = args.evidence_dir.resolve()
    require_safe_output(evidence_root, repository)
    evidence_root.mkdir(parents=True, exist_ok=True)
    metadata = {
        "release_sha": release_sha,
        "environment": "staging",
        "created_at": now(),
        "collector": "collect_e04_e09_evidence.py",
        "mode": "execute" if args.execute else "preflight",
    }
    (evidence_root / "collection-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    statuses: list[dict[str, Any]] = []

    if not args.execute:
        for evidence_id in EVIDENCE_IDS:
            statuses.append({"evidence_id": evidence_id, "status": "BLOCKED", "reason": "preflight-only mode; rerun with --execute during an approved staging window"})
        (evidence_root / "collection-status.json").write_text(json.dumps(statuses, indent=2) + "\n", encoding="utf-8")
        print("preflight complete: no staging systems contacted; E-04 through E-09 remain blocked")
        return 1

    if os.environ.get("STAGING_EVIDENCE_APPROVED") != AUTHORIZATION:
        raise CollectionError("invalid or missing STAGING_EVIDENCE_APPROVED authorization marker")
    verify_release(repository, release_sha)

    for evidence_id in EVIDENCE_IDS:
        command_text = os.environ.get(COMMAND_ENV[evidence_id], "").strip()
        item_dir = evidence_root / evidence_id
        item_dir.mkdir(parents=True, exist_ok=True)
        if not command_text:
            statuses.append({"evidence_id": evidence_id, "status": "BLOCKED", "reason": f"missing protected runner variable {COMMAND_ENV[evidence_id]}"})
            continue
        try:
            command = shlex.split(command_text)
        except ValueError as error:
            statuses.append({"evidence_id": evidence_id, "status": "BLOCKED", "reason": f"invalid runner command syntax: {error}"})
            continue
        if not command:
            statuses.append({"evidence_id": evidence_id, "status": "BLOCKED", "reason": "runner command is empty"})
            continue
        runner_env = os.environ.copy()
        runner_env.update({"EVIDENCE_ID": evidence_id, "RELEASE_SHA": release_sha, "EVIDENCE_DIR": str(item_dir), "EVIDENCE_ENVIRONMENT": "staging"})
        stdout_path = item_dir / "runner.stdout.log"
        stderr_path = item_dir / "runner.stderr.log"
        started = now()
        result = subprocess.run(command, cwd=repository, env=runner_env, capture_output=True, text=True, check=False)
        stdout_path.write_text(result.stdout, encoding="utf-8")
        stderr_path.write_text(result.stderr, encoding="utf-8")
        files = nonempty_files(item_dir)
        artifact_files = [path for path in files if path.name not in {"runner.stdout.log", "runner.stderr.log"}]
        if result.returncode != 0:
            statuses.append({"evidence_id": evidence_id, "status": "FAILED", "return_code": result.returncode, "started_at": started, "finished_at": now(), "reason": "configured staging runner returned non-zero", "evidence_dir": str(item_dir)})
            continue
        if not artifact_files:
            statuses.append({"evidence_id": evidence_id, "status": "BLOCKED", "return_code": 0, "started_at": started, "finished_at": now(), "reason": "runner returned success but produced no non-empty evidence artifact", "evidence_dir": str(item_dir)})
            continue
        artifacts = [{"path": str(path.relative_to(evidence_root)), "sha256": digest(path), "bytes": path.stat().st_size} for path in artifact_files]
        statuses.append({"evidence_id": evidence_id, "status": "READY_FOR_REVIEW", "return_code": 0, "started_at": started, "finished_at": now(), "evidence_dir": str(item_dir), "artifacts": artifacts})

    (evidence_root / "collection-status.json").write_text(json.dumps(statuses, indent=2) + "\n", encoding="utf-8")
    with (evidence_root / "collection-status.tsv").open("w", encoding="utf-8") as stream:
        stream.write("evidence_id\tstatus\treason_or_path\n")
        for row in statuses:
            stream.write(f"{row['evidence_id']}\t{row['status']}\t{row.get('evidence_dir', row.get('reason', ''))}\n")
    blocked = [row for row in statuses if row["status"] != "READY_FOR_REVIEW"]
    if blocked:
        print(f"collection completed with {len(blocked)} blocked/failed evidence item(s); inspect {evidence_root / 'collection-status.json'}")
        return 1
    print(f"collection completed: {len(EVIDENCE_IDS)} evidence items are READY_FOR_REVIEW; independent verification remains required")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Collect E-04 through E-09 staging evidence from explicitly configured runners")
    parser.add_argument("--release-sha", required=True)
    parser.add_argument("--evidence-dir", required=True, type=Path)
    parser.add_argument("--execute", action="store_true", help="execute only with explicit approved staging authorization")
    args = parser.parse_args()
    try:
        return collect(args)
    except (CollectionError, OSError, subprocess.CalledProcessError) as error:
        print(f"E-04 through E-09 collection: FAILED: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
