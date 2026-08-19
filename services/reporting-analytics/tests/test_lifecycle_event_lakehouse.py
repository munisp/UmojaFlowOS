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
        "event_type": "umojaflowos.payment.order.validated.v1",
        "schema_version": "v1",
        "observed_at": "2026-08-19T00:00:00Z",
        "source": "go_payment_engine",
        "correlation_sha256": "3b6a198e6f182f27b91aa5a8b37ab70d4c54d3889e4a947243c1afd3e718ca66",
        "outcome": "approved",
        "authoritative": False,
        "corridor": "NIGERIA_NGN",
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


def test_projection_rejects_an_unapproved_service_source() -> None:
    unapproved = payment_event({"corridor": "NIGERIA_NGN", "status": "APPROVED"})
    unapproved["source"] = "unrecognised-service"
    with pytest.raises(LifecycleEventProjectionError, match="source"):
        build_lifecycle_event_record(unapproved)


def test_projection_maps_go_workflow_outcome_to_temporal_catalog_source() -> None:
    event = payment_event({"status": "APPROVED"})
    event["data"]["event_type"] = "umojaflowos.payment.order.workflow-recorded.v1"
    record = build_lifecycle_event_record(event, datetime(2026, 8, 19, tzinfo=timezone.utc))
    assert record["source"] == "temporal_workflow"
    assert record["outcome"] == "approved"
    assert record["authoritative"] is False


def test_projection_maps_go_permify_outcome_to_authorization_catalog_source() -> None:
    event = payment_event({"decision": "allowed"})
    event["data"]["event_type"] = "umojaflowos.authorization.permify-decision.v1"
    record = build_lifecycle_event_record(event, datetime(2026, 8, 19, tzinfo=timezone.utc))
    assert record["source"] == "permify_authorization"
    assert record["outcome"] == "allowed"
    assert record["authoritative"] is False
