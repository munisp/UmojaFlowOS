from __future__ import annotations

import base64
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = ROOT / "scripts/infra/verify_release_manifest_signatures.py"
SCHEMA = ROOT / "assurance/release_evidence_manifest.schema.json"
SOURCE = ROOT / "assurance/release_evidence_manifest.example.json"
ROLES = ("release_manager", "security_owner", "compliance_owner", "operations_owner")


def canonical(document: dict) -> bytes:
    return json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


with tempfile.TemporaryDirectory(prefix="umoja-signature-test-") as temp:
    root = Path(temp)
    manifest_path = root / "manifest.json"
    signatures = root / "signatures"
    signatures.mkdir()
    manifest = json.loads(SOURCE.read_text())
    # The schema example paths are intentionally placeholders; signature validation
    # checks the manifest and detached approval cryptography, not artifact existence.
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    payload = canonical(manifest)
    digest = __import__("hashlib").sha256(payload).hexdigest()
    for number, role in enumerate(ROLES, start=1):
        subject = manifest["approvals"][number - 1]["subject"]
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

    command = ["python3", str(VALIDATOR), "--manifest", str(manifest_path), "--schema", str(SCHEMA), "--signatures-dir", str(signatures)]
    good = subprocess.run(command, capture_output=True, text=True)
    assert good.returncode == 0, good.stderr
    print("valid fixture: PASS")

    tampered = json.loads((signatures / "security_owner.json").read_text())
    tampered["signature"] = tampered["signature"][:-2] + ("A" if tampered["signature"][-2:] != "AA" else "B")
    (signatures / "security_owner.json").write_text(json.dumps(tampered, indent=2) + "\n")
    bad = subprocess.run(command, capture_output=True, text=True)
    assert bad.returncode != 0
    assert "release manifest signature verification: FAILED:" in bad.stderr
    print("tampered signature: FAIL-CLOSED (rejected)")
