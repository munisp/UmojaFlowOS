from __future__ import annotations

import base64
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = Path(__file__).resolve().parents[2]
VERIFIER = ROOT / "scripts/infra/verify_release_manifest_signatures.py"
SCHEMA = ROOT / "assurance/release_evidence_manifest.schema.json"
SOURCE = ROOT / "assurance/release_evidence_manifest.example.json"
ROLES = ("release_manager", "security_owner", "compliance_owner", "operations_owner")


def canonical(document: dict) -> bytes:
    return json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="umoja-aggregate-signature-test-") as temp:
        root = Path(temp)
        manifest_path = root / "manifest.json"
        signatures = root / "signatures"
        signatures.mkdir()
        manifest = json.loads(SOURCE.read_text())
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        payload = canonical(manifest)
        digest = hashlib.sha256(payload).hexdigest()
        for index, role in enumerate(ROLES, start=1):
            subject = manifest["approvals"][index - 1]["subject"]
            private = Ed25519PrivateKey.generate()
            signed = payload + b"\n" + role.encode() + b"\n" + subject.encode() + b"\n" + manifest["release_sha"].encode()
            sidecar = {
                "role": role,
                "subject": subject,
                "release_sha": manifest["release_sha"],
                "manifest_sha256": digest,
                "algorithm": "Ed25519",
                "public_key": base64.b64encode(private.public_key().public_bytes_raw()).decode(),
                "signature": base64.b64encode(private.sign(signed)).decode(),
            }
            (signatures / f"{role}.json").write_text(json.dumps(sidecar, indent=2) + "\n")
        for role in ROLES:
            sidecar_path = signatures / f"{role}.json"
            sidecar = json.loads(sidecar_path.read_text())
            sidecar["signature"] = base64.b64encode(b"x" * 64).decode()
            sidecar_path.write_text(json.dumps(sidecar, indent=2) + "\n")
        command = ["python3", str(VERIFIER), "--manifest", str(manifest_path), "--schema", str(SCHEMA), "--signatures-dir", str(signatures)]
        result = subprocess.run(command, capture_output=True, text=True)
        assert result.returncode != 0
        combined = result.stderr + result.stdout
        for role in ROLES:
            assert role in combined, combined
        assert "one or more detached approvals failed" in combined, combined
        print("four-role aggregated failure: PASS")


if __name__ == "__main__":
    main()
