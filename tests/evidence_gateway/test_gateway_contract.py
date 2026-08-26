from __future__ import annotations

import hashlib
import os
import httpx
import pytest

GATEWAY_URL = os.getenv("EVIDENCE_GATEWAY_URL")
KEYCLOAK_URL = os.getenv("KEYCLOAK_URL", "http://127.0.0.1:8180")
CLIENT_ID = "umoja-evidence-publisher"
CLIENT_SECRET = "local-only-evidence-secret"
USERNAME = "evidence-test-owner"
PASSWORD = "local-only-owner-password"
RELEASE_SHA = "a" * 40
RUN_ID = "local-contract-test"

pytestmark = pytest.mark.skipif(not GATEWAY_URL, reason="set EVIDENCE_GATEWAY_URL for Compose contract tests")


def token() -> str:
    response = httpx.post(
        f"{KEYCLOAK_URL}/realms/umoja/protocol/openid-connect/token",
        data={
            "grant_type": "password",
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "username": USERNAME,
            "password": PASSWORD,
        },
        timeout=10,
    )
    response.raise_for_status()
    return response.json()["access_token"]


def upload(path: str, body: bytes, jwt_token: str | None = None, digest: str | None = None) -> httpx.Response:
    digest = digest or hashlib.sha256(body).hexdigest()
    return httpx.put(
        f"{GATEWAY_URL}/v1/evidence/{RELEASE_SHA}/{RUN_ID}/{path}",
        content=body,
        headers={
            "Authorization": f"Bearer {jwt_token or token()}",
            "Content-Type": "application/json",
            "X-Evidence-SHA256": digest,
        },
        timeout=10,
    )


def test_health() -> None:
    assert httpx.get(f"{GATEWAY_URL}/healthz", timeout=10).status_code == 200


def test_real_keycloak_jwt_can_upload_to_minio_worm() -> None:
    body = b'{"evidence_id":"E-01","result":"local-only"}\n'
    response = upload("E-01/report.json", body)
    assert response.status_code == 200, response.text
    assert response.json()["sha256"] == hashlib.sha256(body).hexdigest()
    assert response.json()["key"] == f"umoja/releases/{RELEASE_SHA}/{RUN_ID}/E-01/report.json"


def test_digest_mismatch_is_rejected() -> None:
    body = b"tampered-content"
    response = upload("E-01/tampered.json", body, digest="0" * 64)
    assert response.status_code == 400
    assert "does not match body" in response.text


def test_release_mapping_is_server_side() -> None:
    body = b"wrong-release"
    response = httpx.put(
        f"{GATEWAY_URL}/v1/evidence/{'b' * 40}/{RUN_ID}/E-01/report.json",
        content=body,
        headers={
            "Authorization": f"Bearer {token()}",
            "X-Evidence-SHA256": hashlib.sha256(body).hexdigest(),
        },
        timeout=10,
    )
    assert response.status_code == 403
    assert "not active in server-side mapping" in response.text


def test_path_traversal_is_rejected() -> None:
    body = b"path"
    response = upload("../escape.json", body)
    assert response.status_code == 400


def test_invalid_token_is_rejected() -> None:
    response = upload("E-01/invalid.json", b"invalid", jwt_token="not-a-jwt")
    assert response.status_code == 401
    assert "invalid JWT header" in response.text
