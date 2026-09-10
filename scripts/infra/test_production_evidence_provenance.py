#!/usr/bin/env python3
"""Negative/positive tests for production evidence provenance enforcement."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

CHECKER = Path(__file__).with_name("assert_production_evidence_provenance.py")


def run(manifest: Path, structured: Path | None = None) -> subprocess.CompletedProcess[str]:
    command = [sys.executable, str(CHECKER), "--manifest", str(manifest)]
    if structured is not None:
        command.extend(["--structured-evidence-dir", str(structured)])
    return subprocess.run(command, capture_output=True, text=True, check=False)


def write(path: Path, value: object) -> None:
    path.write_text(json.dumps(value) + "\n", encoding="utf-8")


def assert_rejected(result: subprocess.CompletedProcess[str], text: str) -> None:
    assert result.returncode != 0, result.stdout + result.stderr
    assert text in result.stderr, result.stderr


def main() -> int:
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        manifest = root / "manifest.json"
        structured = root / "structured"
        structured.mkdir()

        write(manifest, {"provenance": "authorized_staging", "live_cluster_evidence": True})
        result = run(manifest)
        assert result.returncode == 0, result.stdout + result.stderr
        assert "production evidence provenance: PASS" in result.stdout

        write(manifest, {"provenance": "local_fixture", "live_cluster_evidence": False})
        assert_rejected(run(manifest), "local_fixture provenance is forbidden")

        write(manifest, {"provenance": "authorized_staging", "live_cluster_evidence": False})
        assert_rejected(run(manifest), "live_cluster_evidence=false is forbidden")

        write(manifest, {"provenance": "authorized_staging", "live_cluster_evidence": True})
        write(structured / "E-01.json", {"provenance": "local_fixture", "live_cluster_evidence": False})
        assert_rejected(run(manifest, structured), "local_fixture provenance is forbidden")

        manifest.write_text("{not-json}\n", encoding="utf-8")
        assert_rejected(run(manifest), "cannot read evidence JSON")

    print("production provenance tests: PASS (1 positive, 4 negative cases)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
