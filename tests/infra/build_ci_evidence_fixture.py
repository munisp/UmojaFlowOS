from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/umoja-ci-evidence")
    root.mkdir(parents=True, exist_ok=True)
    sha = subprocess.run(["git", "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    artifacts = []
    for number in range(1, 10):
        evidence_id = f"E-{number:02d}"
        path = root / evidence_id / "ci-contract.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"evidence_id": evidence_id, "ci_fixture": True}) + "\n", encoding="utf-8")
        artifacts.append({
            "evidence_id": evidence_id,
            "path": str(path.relative_to(root)),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "run_id": "ci-contract-fixture",
        })
    approvals = [
        {"role": role, "subject": f"ci-contract-{role}", "release_sha": sha, "approved_at": "2026-08-26T00:00:00Z"}
        for role in ("release_manager", "security_owner", "compliance_owner", "operations_owner")
    ]
    (root / "release.json").write_text(json.dumps({
        "release_sha": sha,
        "environment": "staging",
        "created_at": "2026-08-26T00:00:00Z",
        "artifacts": artifacts,
        "approvals": approvals,
    }, indent=2) + "\n", encoding="utf-8")
    print(root / "release.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
