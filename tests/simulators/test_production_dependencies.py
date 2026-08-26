from __future__ import annotations

import hashlib
import hmac
import time

from fastapi.testclient import TestClient

from simulators.production_dependencies.app import (
    LEDGER,
    REPLAY_CACHE,
    WEBHOOK_SECRET,
    app,
    webhook_secret_from_environment,
)


client = TestClient(app)


def setup_function() -> None:
    LEDGER.clear()
    REPLAY_CACHE.clear()


def test_oidc_edge_and_aml_boundaries() -> None:
    discovery = client.get("/.well-known/openid-configuration")
    assert discovery.status_code == 200
    assert discovery.json()["id_token_signing_alg_values_supported"] == ["RS256"]

    assert client.post(
        "/v1/edge/authorize",
        json={"subject": "user-1", "route": "/admin/audit", "scopes": []},
    ).status_code == 403
    assert client.post(
        "/v1/edge/authorize",
        json={"subject": "user-1", "route": "/admin/audit", "scopes": ["admin"]},
    ).status_code == 200

    clear = client.post(
        "/v1/aml/screen",
        json={"subject_id": "user-1", "email": "safe@example.test"},
    )
    hit = client.post(
        "/v1/aml/screen",
        json={"subject_id": "user-2", "email": "blocked@example.test"},
    )
    assert clear.json()["decision"] == "clear"
    assert hit.json()["decision"] == "hit"
    assert hit.json()["review_required"] is True


def test_ledger_idempotency_and_payload_mismatch() -> None:
    payload = {
        "transfer_id": "transfer-001",
        "debit_account_id": "customer-1",
        "credit_account_id": "provider-1",
        "amount_minor": 1000,
        "currency": "NGN",
        "correlation_id": "corr-001",
    }
    first = client.post("/v1/ledger/transfers", json=payload)
    duplicate = client.post("/v1/ledger/transfers", json=payload)
    mismatch = client.post(
        "/v1/ledger/transfers",
        json={**payload, "amount_minor": 2000},
    )
    assert first.status_code == 200
    assert duplicate.json()["status"] == "duplicate"
    assert mismatch.status_code == 409


def test_p1_workflow_event_siem_and_worm_contracts() -> None:
    workflow = client.post(
        "/v1/workflows/start",
        json={"workflow_id": "workflow-001", "order_id": "order-001", "correlation_id": "corr-001"},
    )
    duplicate_workflow = client.post(
        "/v1/workflows/start",
        json={"workflow_id": "workflow-001", "order_id": "order-001", "correlation_id": "corr-001"},
    )
    event = client.post(
        "/v1/events/publish",
        json={"event_id": "event-001", "event_type": "payment.order.validated.v1", "schema_version": "v1", "correlation_id": "corr-001", "payload": {"order_id": "order-001"}},
    )
    incident = client.post(
        "/v1/wazuh/incidents",
        json={"rule_id": "100820", "dedup_key": "tamper-001", "path": "/var/log/umoja/sod-audit.jsonl"},
    )
    worm = client.post(
        "/v1/worm/attest",
        json={"object_version_id": "version-001", "sha256": "a" * 64, "signature_valid": True, "retention_mode": "COMPLIANCE", "retain_until": "2099-01-01T00:00:00Z"},
    )
    assert workflow.json()["status"] == "started"
    assert duplicate_workflow.json()["workflow_id"] == "workflow-001"
    assert event.json()["status"] == "published"
    assert incident.json()["status"] == "accepted"
    assert worm.json()["status"] == "accepted"


def test_p2_lakehouse_redaction_and_entity_resolution() -> None:
    accepted = client.post(
        "/v1/lakehouse/bronze",
        json={"event_id": "lake-001", "occurred_at": "2026-01-01T00:00:00Z", "source": "payments", "payload": {"amount_minor": 100}},
    )
    rejected = client.post(
        "/v1/lakehouse/bronze",
        json={"event_id": "lake-002", "occurred_at": "2026-01-01T00:00:00Z", "source": "payments", "payload": {"token": "must-not-land"}},
    )
    resolved = client.post(
        "/v1/entity-resolution/resolve",
        json={"match_threshold": 0.66, "records": [
            {"record_id": "a", "full_name": "Ada Lovelace", "email": "ada@example.test"},
            {"record_id": "b", "full_name": "Ada Lovelace", "email": "ada@example.test"},
            {"record_id": "c", "full_name": "Grace Hopper", "email": "grace@example.test"},
        ]},
    )
    assert accepted.status_code == 200
    assert rejected.status_code == 422
    assert resolved.status_code == 200
    assert any(set(cluster) == {"a", "b"} for cluster in resolved.json()["clusters"])


def test_webhook_secret_must_be_explicit_and_long_enough(monkeypatch) -> None:
    monkeypatch.delenv("SIMULATOR_WEBHOOK_SECRET", raising=False)
    try:
        webhook_secret_from_environment()
    except RuntimeError as exc:
        assert "supplied explicitly" in str(exc)
    else:
        raise AssertionError("missing simulator webhook secret must fail closed")

    monkeypatch.setenv("SIMULATOR_WEBHOOK_SECRET", "short")
    try:
        webhook_secret_from_environment()
    except RuntimeError as exc:
        assert "at least 32 bytes" in str(exc)
    else:
        raise AssertionError("short simulator webhook secret must fail closed")


def test_webhook_signature_replay_and_stale_guards() -> None:
    body = b'{"event":"settled","amount_minor":1000}'
    timestamp = str(int(time.time()))
    signature = hmac.new(
        WEBHOOK_SECRET,
        timestamp.encode() + b"." + body,
        hashlib.sha256,
    ).hexdigest()
    headers = {
        "X-Provider-Timestamp": timestamp,
        "X-Provider-Signature": signature,
        "X-Provider-Event-Id": "evt-001",
    }
    accepted = client.post("/v1/webhooks/provider", content=body, headers=headers)
    replay = client.post("/v1/webhooks/provider", content=body, headers=headers)
    bad_signature = client.post(
        "/v1/webhooks/provider",
        content=body,
        headers={**headers, "X-Provider-Event-Id": "evt-002", "X-Provider-Signature": "0" * 64},
    )
    stale = client.post(
        "/v1/webhooks/provider",
        content=body,
        headers={
            **headers,
            "X-Provider-Event-Id": "evt-003",
            "X-Provider-Timestamp": str(int(time.time()) - 1000),
        },
    )
    assert accepted.status_code == 200
    assert replay.status_code == 409
    assert bad_signature.status_code == 401
    assert stale.status_code == 401
