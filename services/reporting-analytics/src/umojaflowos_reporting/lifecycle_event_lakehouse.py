"""Redacted lifecycle-event projection for the governed analytics lakehouse.

The event stream is useful for operational analytics and model features, but it
is not an unrestricted export path.  This module projects only a documented
allowlist from already-validated Dapr evidence.  PostgreSQL remains the
operational system of record; TigerBeetle remains the activated accounting
record; the bronze object is immutable analytics evidence.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping

from .lakehouse_writer import BronzeLakehouseWriter


PAYMENT_ORDER_VALIDATED_EVENT = "umojaflowos.payment.order.validated.v1"
POLICY_DECISION_EVENT = "umojaflowos.policy.decision.v1"

# No customer, beneficiary, account, wallet, document, credential, raw source,
# amount, or free-text reason crosses this boundary.  The analytics lakehouse
# gets lifecycle category evidence, not a copy of the payment instruction.
PAYMENT_PAYLOAD_ALLOWLIST = {"corridor", "currency", "status", "policy_version", "provider_category", "leg_count"}
POLICY_PAYLOAD_ALLOWLIST = {"corridor", "decision", "policy_version", "risk_band", "rule_code"}


class LifecycleEventProjectionError(ValueError):
    pass


def _clean_string(value: object, field: str, maximum: int = 128) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise LifecycleEventProjectionError(f"lifecycle event {field} is invalid")
    return value.strip()


def build_lifecycle_event_record(event: Mapping[str, Any], received_at: datetime | None = None) -> dict[str, object]:
    """Create a narrow, deterministic lakehouse record from validated event evidence."""

    data = event.get("data")
    if not isinstance(data, Mapping):
        raise LifecycleEventProjectionError("lifecycle event data is invalid")
    event_type = _clean_string(data.get("event_type"), "event_type", 255)
    if event_type not in {PAYMENT_ORDER_VALIDATED_EVENT, POLICY_DECISION_EVENT}:
        raise LifecycleEventProjectionError("lifecycle event type is not approved for analytics projection")
    payload = data.get("payload")
    if not isinstance(payload, Mapping):
        raise LifecycleEventProjectionError("lifecycle event payload is invalid")

    record: dict[str, object] = {
        "event_id": _clean_string(data.get("event_id"), "event_id", 255),
        "correlation_id": _clean_string(data.get("correlation_id"), "correlation_id", 255),
        "event_type": event_type,
        "schema_version": "v1",
        "received_at": (received_at or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat(),
        "source_service": _clean_string(event.get("source"), "source", 255),
    }
    allowlist = PAYMENT_PAYLOAD_ALLOWLIST if event_type == PAYMENT_ORDER_VALIDATED_EVENT else POLICY_PAYLOAD_ALLOWLIST
    for key in sorted(allowlist):
        value = payload.get(key)
        if isinstance(value, (str, int, bool)) and (not isinstance(value, str) or len(value) <= 128):
            record[f"payload_{key}"] = value
    return record


def project_lifecycle_event(writer: BronzeLakehouseWriter, event: Mapping[str, Any], received_at: datetime | None = None) -> tuple[str, str]:
    """Write one idempotent redacted lifecycle-evidence record to bronze storage."""

    record = build_lifecycle_event_record(event, received_at)
    _manifest, key, status = writer.write("payment-lifecycle-evidence", [record], "v1")
    return key, status
