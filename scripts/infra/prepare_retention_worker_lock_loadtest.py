#!/usr/bin/env python3
"""Prepare synthetic, non-deleting requests for Locust row-lock load tests.

The script uses the Gateway database credential only to register authorization
rows. Every payload targets a deliberately non-existent index, so the worker
claims the authorization and returns `already_deleted` without an OpenSearch
DELETE request.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg

from simulators.retention_gateway.decision_engine import DeleteRequest, HMACAuthorizationSigner
from simulators.retention_gateway.delete_worker import PostgresAuthorizationUseStore


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def build_payload(signer: HMACAuthorizationSigner, store: PostgresAuthorizationUseStore, sequence: int, expires_at: datetime) -> dict[str, str]:
    nonce = secrets.token_hex(12)
    index = f"umoja-loadtest-nonexistent-{sequence}-{nonce}"
    request = DeleteRequest(
        index=index,
        index_uuid=f"loadtest-uuid-{sequence}",
        index_version="1",
        expected_digest=sha256_hex(f"archive:{index}"),
        requested_by="retention-loadtest",
        correlation_id=f"lock-loadtest-{sequence}-{nonce}",
    )
    decision_digest = sha256_hex(f"decision:{request.correlation_id}:{request.expected_digest}")
    store.register(decision_digest, expires_at)
    return {
        "index": request.index,
        "index_uuid": request.index_uuid,
        "index_version": request.index_version,
        "expected_digest": request.expected_digest,
        "requested_by": request.requested_by,
        "correlation_id": request.correlation_id,
        "decision_digest": decision_digest,
        "authorization_token": signer.sign(request, decision_digest, expires_at),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=10000, help="Number of unique authorizations to prepare")
    parser.add_argument("--output", default="/tmp/retention-worker-loadtest-fixture.json")
    parser.add_argument("--ttl-minutes", type=int, default=30)
    args = parser.parse_args()

    database_url = os.environ["RETENTION_GATEWAY_DATABASE_URL"]
    secret = Path(os.environ["RETENTION_GATEWAY_HMAC_SECRET_FILE"]).read_bytes().strip()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=args.ttl_minutes)
    store = PostgresAuthorizationUseStore(lambda: psycopg.connect(database_url))
    signer = HMACAuthorizationSigner(secret)

    payloads = [build_payload(signer, store, sequence, expires_at) for sequence in range(args.count)]
    contention = build_payload(signer, store, args.count + 1, expires_at)
    document = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": expires_at.isoformat(),
        "unique_payloads": payloads,
        "contention_payload": contention,
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(document))
    output.chmod(0o600)
    print(json.dumps({"output": str(output), "unique_payloads": len(payloads), "expires_at": document["expires_at"]}))


if __name__ == "__main__":
    main()
