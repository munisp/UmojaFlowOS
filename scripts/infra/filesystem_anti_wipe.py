#!/usr/bin/env python3
"""Filesystem anti-wipe guardian for UmojaFlowOS evidence surfaces.

Protects the platform's evidentiary filesystem (compliance evidence, audit
logs, lakehouse artifacts, model registry, schema migrations) against
deletion, truncation, and silent modification.

Layers of defence, each independently verifiable:

1. Hash-chain manifest — every protected file is sha256-hashed; hashes are
   chained in sorted order so removing ANY link changes the chain root.
2. Append-only audit log — every build/verify run appends a JSON line that
   itself chains on the previous line's hash (tampering with history breaks
   the chain).
3. OS immutability — ``chattr +i`` (immutable) for terminal evidence and
   ``chattr +a`` (append-only) for audit logs where the filesystem supports
   it; degrades to chmod read-only with a recorded capability note.
4. Fail-closed verification — ``verify`` exits non-zero on any missing,
   modified, or truncated file, so CI/cron/systemd alert on wipe attempts.

CLI:
    filesystem_anti_wipe.py build   --root REPO --config CONFIG --manifest M --log LOG
    filesystem_anti_wipe.py verify  --root REPO --config CONFIG --manifest M --log LOG
    filesystem_anti_wipe.py enforce --root REPO --config CONFIG
    filesystem_anti_wipe.py audit   --log LOG
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

CHUNK = 1 << 20  # 1 MiB read chunks


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            block = fh.read(CHUNK)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def chain_root(entries: list[dict]) -> str:
    """Order-sensitive hash chain over (path, sha256) — deletion changes root."""
    h = hashlib.sha256(b"umojaflowos-anti-wipe-v1")
    for entry in sorted(entries, key=lambda e: e["path"]):
        h.update(entry["path"].encode())
        h.update(b"\x00")
        h.update(entry["sha256"].encode())
        h.update(b"\x1e")
    return h.hexdigest()


@dataclass
class ProtectedPath:
    path: str
    klass: str
    immutable: bool = False
    append_only: bool = False
    retention_days: int | None = None


@dataclass
class Config:
    protected: list[ProtectedPath] = field(default_factory=list)

    @staticmethod
    def load(path: Path) -> "Config":
        raw = json.loads(path.read_text())
        return Config(protected=[
            ProtectedPath(
                path=p["path"], klass=p["class"],
                immutable=bool(p.get("immutable", False)),
                append_only=bool(p.get("append_only", False)),
                retention_days=p.get("retention_days"),
            )
            for p in raw["protected"]
        ])


def iter_files(root: Path, rel: str) -> list[Path]:
    base = root / rel
    if base.is_file():
        return [base]
    if not base.exists():
        return []
    return sorted(p for p in base.rglob("*") if p.is_file() and not p.is_symlink())


def build_entries(root: Path, config: Config) -> list[dict]:
    entries: list[dict] = []
    for pp in config.protected:
        for f in iter_files(root, pp.path):
            st = f.stat()
            entries.append({
                "path": str(f.relative_to(root)),
                "sha256": sha256_file(f),
                "size": st.st_size,
                "class": pp.klass,
                "append_only": pp.append_only,
                "recorded_at": utcnow(),
            })
    return entries


def append_log(log_path: Path, event: dict) -> str:
    """Append a hash-chained JSON line; returns this line's chain hash."""
    prev = "0" * 64
    if log_path.exists():
        lines = [l for l in log_path.read_text().splitlines() if l.strip()]
        if lines:
            prev = json.loads(lines[-1])["chain"]
    payload = json.dumps(event, sort_keys=True)
    chain = hashlib.sha256((prev + payload).encode()).hexdigest()
    with log_path.open("a") as fh:
        fh.write(json.dumps({**event, "prev": prev, "chain": chain}) + "\n")
    return chain


def cmd_build(root: Path, config: Config, manifest: Path, log: Path) -> int:
    entries = build_entries(root, config)
    doc = {"version": 1, "built_at": utcnow(), "root": chain_root(entries), "entries": entries}
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(doc, indent=2, sort_keys=True))
    append_log(log, {"event": "build", "at": doc["built_at"],
                     "files": len(entries), "root": doc["root"]})
    print(f"manifest built: {len(entries)} files, root={doc['root'][:16]}…")
    return 0


def verify(root: Path, config: Config, manifest: Path) -> list[str]:
    doc = json.loads(manifest.read_text())
    recorded = {e["path"]: e for e in doc["entries"]}
    violations: list[str] = []

    for rel, entry in sorted(recorded.items()):
        f = root / rel
        if not f.exists():
            violations.append(f"MISSING (deleted/wiped): {rel} [class={entry['class']}]")
            continue
        actual = sha256_file(f)
        if actual != entry["sha256"]:
            if entry.get("append_only") and f.stat().st_size >= entry["size"]:
                # append-only files may grow; the recorded prefix must be intact.
                with f.open("rb") as fh:
                    prefix = fh.read(entry["size"])
                if hashlib.sha256(prefix).hexdigest() == entry["sha256"]:
                    continue
            if f.stat().st_size < entry["size"]:
                violations.append(f"TRUNCATED (append-only violation): {rel}")
            else:
                violations.append(f"MODIFIED (hash mismatch): {rel}")
    # unexpected new files inside immutable classes are also evidence of tampering
    for pp in config.protected:
        if not pp.immutable:
            continue
        for f in iter_files(root, pp.path):
            rel = str(f.relative_to(root))
            if rel not in recorded:
                violations.append(f"UNRECORDED (in immutable class {pp.klass}): {rel}")
    return violations


def cmd_verify(root: Path, config: Config, manifest: Path, log: Path) -> int:
    violations = verify(root, config, manifest)
    append_log(log, {"event": "verify", "at": utcnow(),
                     "violations": len(violations), "ok": not violations})
    if violations:
        print("ANTI-WIPE VIOLATIONS (fail-closed):", file=sys.stderr)
        for v in violations:
            print(f"  - {v}", file=sys.stderr)
        return 1
    print("verify ok: no deletions, modifications, or truncations detected")
    return 0


def _chattr_supported() -> bool:
    return shutil.which("chattr") is not None and sys.platform.startswith("linux")


def enforce(root: Path, config: Config) -> list[str]:
    """Apply OS-level protections. Returns capability notes (never raises)."""
    notes: list[str] = []
    for pp in config.protected:
        for f in iter_files(root, pp.path):
            if pp.immutable or pp.append_only:
                # strip write bits first — portable baseline on every fs
                f.chmod(f.stat().st_mode & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))
            if not _chattr_supported():
                notes.append(f"chattr unavailable — chmod-ro only: {f}")
                continue
            flag = "+i" if pp.immutable else ("+a" if pp.append_only else None)
            if flag is None:
                continue
            proc = subprocess.run(["chattr", flag, str(f)], capture_output=True, text=True)
            notes.append(f"chattr {flag} {f}: {'ok' if proc.returncode == 0 else proc.stderr.strip()}")
    return notes


def cmd_enforce(root: Path, config: Config) -> int:
    notes = enforce(root, config)
    for n in notes:
        print(n)
    print(f"enforce complete: {len(notes)} operations")
    return 0


def cmd_audit(log: Path) -> int:
    """Verify the audit log's own hash chain end to end."""
    prev = "0" * 64
    count = 0
    for line in log.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        event = {k: v for k, v in row.items() if k not in ("prev", "chain")}
        expect = hashlib.sha256((prev + json.dumps(event, sort_keys=True)).encode()).hexdigest()
        if row["prev"] != prev or row["chain"] != expect:
            print(f"AUDIT LOG TAMPERED at line {count + 1}", file=sys.stderr)
            return 1
        prev, count = row["chain"], count + 1
    print(f"audit log intact: {count} chained events")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=["build", "verify", "enforce", "audit"])
    ap.add_argument("--root", type=Path, default=Path.cwd())
    ap.add_argument("--config", type=Path)
    ap.add_argument("--manifest", type=Path)
    ap.add_argument("--log", type=Path)
    args = ap.parse_args(argv)

    if args.command == "audit":
        if not args.log:
            ap.error("--log required for audit")
        return cmd_audit(args.log)
    if not args.config:
        ap.error("--config required")
    config = Config.load(args.config)
    if args.command == "build":
        return cmd_build(args.root, config, args.manifest, args.log)
    if args.command == "verify":
        return cmd_verify(args.root, config, args.manifest, args.log)
    if args.command == "enforce":
        return cmd_enforce(args.root, config)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
