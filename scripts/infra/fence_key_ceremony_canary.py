#!/usr/bin/env python3
"""Ed25519 fence-key ceremony helper and payment-engine canary client.

Production use requires an approved HSM/remote signer. This script is suitable
for an offline ceremony rehearsal or an approved file-backed test ceremony.
It never sends private key material to the payment engine.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import secrets
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def utc_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def canonical_command(command: dict) -> bytes:
    # Matches Go json.Marshal(FenceCommand) field order and compact encoding.
    ordered = {
        "command_id": command["command_id"],
        "action": command["action"],
        "reason": command["reason"],
        "environment": command["environment"],
        "source_alerts": command["source_alerts"],
        "issued_at": command["issued_at"],
        "expires_at": command["expires_at"],
        "nonce": command["nonce"],
        "signer": command["signer"],
        "signature": "",
    }
    return json.dumps(ordered, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def generate_keypair(private_path: Path, public_path: Path) -> str:
    private = Ed25519PrivateKey.generate()
    public = private.public_key()
    private_path.write_bytes(
        private.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    public_path.write_bytes(
        public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    )
    os.chmod(private_path, 0o600)
    os.chmod(public_path, 0o644)
    digest = hashlib.sha256(public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).hexdigest()
    print(f"public_key_sha256={digest}")
    print(f"public_key_b64={base64.b64encode(public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()}")
    return digest


def load_private(path: Path) -> Ed25519PrivateKey:
    value = serialization.load_pem_private_key(path.read_bytes(), password=None)
    if not isinstance(value, Ed25519PrivateKey):
        raise SystemExit("key is not Ed25519")
    return value


def make_command(private: Ed25519PrivateKey, environment: str, action: str, reason: str, endpoint_alert: str) -> dict:
    now = datetime.now(timezone.utc)
    command = {
        "command_id": f"canary-{now.strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(8)}",
        "action": action,
        "reason": reason,
        "environment": environment,
        "source_alerts": [endpoint_alert],
        "issued_at": utc_z(now - timedelta(seconds=5)),
        "expires_at": utc_z(now + timedelta(minutes=5)),
        "nonce": secrets.token_urlsafe(24),
        "signer": "offline-fence-ceremony-canary",
        "signature": "",
    }
    signature = private.sign(canonical_command(command))
    command["signature"] = base64.b64encode(signature).decode("ascii")
    return command


def send(endpoint: str, command: dict, bearer: str | None) -> None:
    payload = json.dumps(command, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(endpoint, data=payload, method="POST", headers={"Content-Type": "application/json"})
    if bearer:
        request.add_header("Authorization", f"Bearer {bearer}")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            body = response.read().decode("utf-8")
            print(f"http_status={response.status}")
            print(body)
            if response.status != 200:
                raise SystemExit("canary command was not accepted")
    except Exception as exc:
        raise SystemExit(f"canary request failed: {exc}") from exc


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--generate", action="store_true")
    parser.add_argument("--private-key", type=Path, default=Path("bridge-ed25519-private.pem"))
    parser.add_argument("--public-key", type=Path, default=Path("bridge-ed25519-public.raw"))
    parser.add_argument("--canary", action="store_true")
    parser.add_argument("--endpoint", default="https://payment-engine.example.invalid/v1/fence")
    parser.add_argument("--bearer-token")
    parser.add_argument("--environment", default="staging")
    args = parser.parse_args()

    if args.generate:
        generate_keypair(args.private_key, args.public_key)

    if args.canary:
        if not args.private_key.exists():
            raise SystemExit(f"private key not found: {args.private_key}")
        command = make_command(load_private(args.private_key), args.environment, "FENCE", "OPA canary verification", "UmojaOPARetryExhaustion")
        print(json.dumps(command, indent=2))
        send(args.endpoint, command, args.bearer_token)
        print("CANARY_PASS: signed FENCE command accepted")

    if not args.generate and not args.canary:
        parser.error("select --generate and/or --canary")
    return 0


if __name__ == "__main__":
    sys.exit(main())
