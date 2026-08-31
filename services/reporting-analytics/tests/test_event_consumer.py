"""Dapr/Kafka subscriber boundary regressions.

The service deliberately starts with no durable event ledger. These tests prove
that it rejects malformed evidence and returns 503 when the durable store is
unavailable, which makes Dapr retry rather than acknowledge and lose an event.
The successful path is covered in the Redis integration tests once the real
ledger is attached; no in-memory recorder is substituted here.
"""

import pytest
from fastapi.testclient import TestClient

import umojaflowos_reporting.service as service
from umojaflowos_reporting.service import app


client = TestClient(app)


@pytest.fixture(autouse=True)
def unavailable_event_ledger():
    previous = service.EVENT_EVIDENCE_LEDGER
    service.EVENT_EVIDENCE_LEDGER = service.UnavailableEventEvidenceLedger()
    try:
        yield
    finally:
        service.EVENT_EVIDENCE_LEDGER = previous


def event(data: dict) -> dict:
    return {
        "id": "dapr-id-1",
        "source": "payment-engine",
        "specversion": "1.0",
        "type": "com.dapr.event.sent",
        "topic": "payment.events",
        "pubsubname": "kafka",
        "data": data,
    }


def valid_data() -> dict:
    return {
        "event_id": "event-1",
        "event_type": "umojaflowos.payment.order.validated.v1",
        "schema_version": "v1",
        "correlation_id": "order-1",
        "payload": {"status": "APPROVED"},
    }


def test_consumer_retries_when_no_durable_ledger_is_configured() -> None:
    response = client.post("/events/payment-order-validated", json=event(valid_data()))
    assert response.status_code == 503
    assert response.json()["detail"] == "event evidence ledger is unavailable"


def test_consumer_refuses_unknown_stream_before_attempting_persistence() -> None:
    payload = event(valid_data())
    payload["topic"] = "untrusted.events"
    response = client.post("/events/payment-order-validated", json=payload)
    assert response.status_code == 422
    assert response.json()["detail"] == "event arrived through an unrecognised stream"


def test_consumer_refuses_incomplete_evidence() -> None:
    payload = event(valid_data())
    payload["data"].pop("correlation_id")
    response = client.post("/events/payment-order-validated", json=payload)
    assert response.status_code == 422
    assert response.json()["detail"] == "event evidence is incomplete"


def test_consumer_refuses_an_unrecognised_contract_version() -> None:
    payload = event(valid_data())
    payload["data"]["schema_version"] = "v2"
    response = client.post("/events/payment-order-validated", json=payload)
    assert response.status_code == 422
    assert response.json()["detail"] == "event evidence schema version is not supported"


def test_consumer_refuses_an_execution_shaped_event_type() -> None:
    payload = event(valid_data())
    payload["data"]["event_type"] = "umojaflowos.payment.execute.v1"
    response = client.post("/events/payment-order-validated", json=payload)
    assert response.status_code == 422
    assert response.json()["detail"] == "event evidence type is not recognised"
