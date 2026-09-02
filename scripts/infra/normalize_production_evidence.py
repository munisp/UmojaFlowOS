#!/usr/bin/env python3
"""Normalize collected E-01..E-09 evidence for the production GO gate.

The collector may store evidence under E-01/ .. E-09/. The current GO gate expects
14 exact filenames directly under --output-dir. This script copies only an
unambiguous source for each required target, preserves bytes, records provenance,
and fails closed on missing/duplicate/invalid inputs. It never creates evidence.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

REQUIRED: dict[str, tuple[str, ...]] = {
    "cluster_version.txt": ("E-01",),
    "rollout-status.txt": ("E-02", "E-06"),
    "workload-state.yaml": ("E-06",),
    "adapter-hpa-validation-final.json": ("E-06",),
    "hpa-live-samples.log": ("E-06",),
    "metric-baseline.json": ("E-06",),
    "postgres-contention.json": ("E-02", "E-06"),
    "istio-mtls-rbac.json": ("E-06",),
    "otel-trace-health.json": ("E-07",),
    "fabric-commit-latency.json": ("E-04",),
    "vault-rotation-canary.json": ("E-08",),
    "worm-object-lock.json": ("E-09",),
    "hsm-key-custody.json": ("E-08",),
    "dr-recovery.json": ("E-08",),
}
SHA_RE = re.compile(r"^[a-f0-9]{40}$")
RUN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def fail(message: str) -> None:
    raise SystemExit(f"NORMALIZATION FAILED: {message}")


def metadata_value(source: Path, key: str) -> str | None:
    for candidate in (source / "collection-metadata.json", source.parent / "collection-metadata.json"):
        if not candidate.is_file():
            continue
        try:
            data = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        value = data.get(key)
        if isinstance(value, str):
            return value
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--release-sha", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--force", action="store_true", help="allow replacement only when output is an existing normalizer output")
    args = parser.parse_args()

    if not SHA_RE.fullmatch(args.release_sha):
        fail("release SHA must be 40 lowercase hexadecimal characters")
    if not RUN_RE.fullmatch(args.run_id):
        fail("run ID has invalid format")
    source = args.source_dir.resolve()
    output = args.output_dir.resolve()
    if not source.is_dir():
        fail(f"source directory does not exist: {source}")
    if source == output:
        fail("source and output directories must differ")

    source_meta = source / "collection-metadata.json"
    if source_meta.is_file():
        try:
            metadata = json.loads(source_meta.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            fail(f"invalid collection-metadata.json: {exc}")
        if metadata.get("release_sha") != args.release_sha:
            fail("collection metadata release_sha mismatch")
        if metadata.get("reconciliation_run_id") not in {None, args.run_id}:
            fail("collection metadata reconciliation_run_id mismatch")
        if metadata.get("environment") not in {None, "staging"}:
            fail("source evidence is not marked staging")

    output.mkdir(parents=True, exist_ok=True)
    prior = output / "normalization-metadata.json"
    if any(output.iterdir()) and not prior.is_file():
        fail("output directory is non-empty and was not created by this normalizer")
    if prior.is_file() and not args.force:
        fail("output already contains a normalization result; use --force only after review")

    records: list[dict[str, object]] = []
    for target, allowed_evidence_ids in REQUIRED.items():
        candidates: list[Path] = []
        for evidence_id in allowed_evidence_ids:
            item = source / evidence_id
            if not item.is_dir():
                continue
            candidates.extend(p for p in item.rglob(target) if p.is_file() and p.stat().st_size > 0)
        # Also support a collector that wrote canonical files at source root.
        root_candidate = source / target
        if root_candidate.is_file() and root_candidate.stat().st_size > 0:
            candidates.append(root_candidate)
        candidates = sorted(set(p.resolve() for p in candidates))
        if len(candidates) == 0:
            fail(f"no unambiguous source found for {target}; expected under {allowed_evidence_ids}")
        if len(candidates) != 1:
            fail(f"ambiguous sources for {target}: {', '.join(str(p) for p in candidates)}")
        src = candidates[0]
        dst = output / target
        if dst.exists() and not args.force:
            fail(f"target already exists: {dst}")
        shutil.copyfile(src, dst)
        records.append({
            "target": target,
            "source": str(src),
            "sha256": digest(dst),
            "bytes": dst.stat().st_size,
            "release_sha": args.release_sha,
            "reconciliation_run_id": args.run_id,
        })

    metadata = {
        "status": "NORMALIZED_FOR_GO_GATE",
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "release_sha": args.release_sha,
        "reconciliation_run_id": args.run_id,
        "source_dir": str(source),
        "output_dir": str(output),
        "live_evidence_not_created": True,
        "files": records,
    }
    (output / "normalization-metadata.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    with (output / "normalization-sha256sums.txt").open("w", encoding="utf-8") as stream:
        for record in records:
            stream.write(f"{record['sha256']}  {record['target']}\n")
    print(json.dumps(metadata, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        print(f"NORMALIZATION FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
