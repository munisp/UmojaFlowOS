"""Live Redis regressions for the Dapr event evidence ledger.

These tests connect to the actual local Redis server on a dedicated database
(`15`) rather than substituting an in-memory cache. That is important because
the property we need is Redis's atomic Lua execution: a duplicate must not be
able to add a second stream entry even if deliveries race.
"""

import json

import pytest
from fastapi.testclient import TestClient
from redis import Redis

import umojaflowos_reporting.service as service


REDIS_URL = "redis://127.0.0.1:6379/15"


def event() -> dict:
    return {
        "id": "dapr-live-redis-event-1",
        "source": "payment-engine",
        "specversion": "1.0",
        "type": "com.dapr.event.sent",
        "topic": "payment.events",
        "pubsubname": "kafka",
        "data": {
            "event_id": "redis-event-1",
            "event_type": "umojaflowos.payment.order.validated.v1",
            "schema_version": "v1",
            "correlation_id": "order-redis-1",
            "payload": {"status": "APPROVED"},
        },
    }


@pytest.fixture(autouse=True)
def real_redis_ledger():
    redis = Redis.from_url(REDIS_URL, decode_responses=True)
    try:
        redis.ping()
    except Exception as exc:  # pragma: no cover - explicit environment block
        pytest.skip(f"local Redis is not running: {exc}")
    # Database 15 is reserved for this regression; it holds no operational data.
    redis.delete(service.RedisEventEvidenceLedger._STREAM_KEY)
    for key in redis.scan_iter(match=f"{service.RedisEventEvidenceLedger._DEDUPE_PREFIX}*"):
        redis.delete(key)

    service.configure_event_evidence_ledger(REDIS_URL)
    try:
        yield redis
    finally:
        service.EVENT_EVIDENCE_LEDGER = service.UnavailableEventEvidenceLedger()
        redis.delete(service.RedisEventEvidenceLedger._STREAM_KEY)
        for key in redis.scan_iter(match=f"{service.RedisEventEvidenceLedger._DEDUPE_PREFIX}*"):
            redis.delete(key)


def test_real_redis_records_once_then_acknowledges_duplicates(real_redis_ledger: Redis) -> None:
    client = TestClient(service.app)
    first = client.post("/events/payment-order-validated", json=event())
    assert first.status_code == 200
    assert first.json() == {"status": "SUCCESS", "delivery": "recorded"}

    second = client.post("/events/payment-order-validated", json=event())
    assert second.status_code == 200
    assert second.json() == {"status": "SUCCESS", "delivery": "duplicate"}

    assert real_redis_ledger.xlen(service.RedisEventEvidenceLedger._STREAM_KEY) == 1
    _, fields = real_redis_ledger.xrange(service.RedisEventEvidenceLedger._STREAM_KEY, count=1)[0]
    captured = json.loads(fields["cloud_event"])
    assert captured["data"]["event_id"] == "redis-event-1"
    assert captured["data"]["correlation_id"] == "order-redis-1"
    # The exact CloudEvent is preserved as a canonical JSON string — no caller
    # may replace it with an interpreted approval or an execution instruction.
    assert captured["data"]["payload"] == {"status": "APPROVED"}


def test_redis_ledger_hashes_untrusted_event_ids_in_its_keyspace(real_redis_ledger: Redis) -> None:
    payload = event()
    payload["data"]["event_id"] = "../untrusted event id/with separators"
    client = TestClient(service.app)
    response = client.post("/events/payment-order-validated", json=payload)
    assert response.status_code == 200
    keys = list(real_redis_ledger.scan_iter(match=f"{service.RedisEventEvidenceLedger._DEDUPE_PREFIX}*"))
    assert len(keys) == 1
    assert ".." not in keys[0]
    assert "/" not in keys[0]
