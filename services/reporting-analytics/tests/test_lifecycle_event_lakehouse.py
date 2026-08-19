from datetime import datetime, timezone

import pytest

from umojaflowos_reporting.lifecycle_event_lakehouse import (
    LifecycleEventProjectionError,
    build_lifecycle_event_record,
)


def payment_event(payload: dict) -> dict:
    return {
        "source": "payment-engine",
        "data": {
            "event_id": "event-123",
            "event_type": "umojaflowos.payment.order.validated.v1",
            "schema_version": "v1",
            "correlation_id": "order-123",
            "payload": payload,
        },
    }


def test_projection_keeps_only_approved_lifecycle_fields() -> None:
    record = build_lifecycle_event_record(
        payment_event(
            {
                "corridor": "NIGERIA_NGN",
                "currency": "NGN",
                "status": "APPROVED",
                "customer_name": "must-not-cross",
                "account_number": "must-not-cross",
                "amount": "50000.00",
                "free_text_reason": "must-not-cross",
            }
        ),
        datetime(2026, 8, 19, tzinfo=timezone.utc),
    )
    assert record == {
        "event_id": "event-123",
        "correlation_id": "order-123",
        "event_type": "umojaflowos.payment.order.validated.v1",
        "schema_version": "v1",
        "received_at": "2026-08-19T00:00:00+00:00",
        "source_service": "payment-engine",
        "payload_corridor": "NIGERIA_NGN",
        "payload_currency": "NGN",
        "payload_status": "APPROVED",
    }


def test_projection_refuses_unknown_event_type_and_invalid_correlation() -> None:
    unknown = payment_event({"status": "APPROVED"})
    unknown["data"]["event_type"] = "umojaflowos.payment.execute.v1"
    with pytest.raises(LifecycleEventProjectionError, match="not approved"):
        build_lifecycle_event_record(unknown)

    invalid = payment_event({"status": "APPROVED"})
    invalid["data"]["correlation_id"] = ""
    with pytest.raises(LifecycleEventProjectionError, match="correlation_id"):
        build_lifecycle_event_record(invalid)
