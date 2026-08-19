"""Redacted lifecycle-event projection for the governed analytics lakehouse.

The event stream is useful for operational analytics and model features, but it
is not an unrestricted export path.  This module projects only a documented
allowlist from already-validated Dapr evidence.  PostgreSQL remains the
operational system of record; TigerBeetle remains the activated accounting
record; the bronze object is immutable analytics evidence.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from typing import Any, Mapping

from .lakehouse_catalog import build_catalog_evidence, write_catalog_evidence
from .lakehouse_writer import BronzeLakehouseWriter


PAYMENT_ORDER_VALIDATED_EVENT = "umojaflowos.payment.order.validated.v1"
POLICY_DECISION_EVENT = "umojaflowos.policy.decision.v1"
PAYMENT_ORDER_WORKFLOW_RECORDED_EVENT = "umojaflowos.payment.order.workflow-recorded.v1"
PERMIFY_DECISION_EVENT = "umojaflowos.authorization.permify-decision.v1"

# No customer, beneficiary, account, wallet, document, credential, raw source,
# amount, or free-text reason crosses this boundary.  The analytics lakehouse
# gets lifecycle category evidence, not a copy of the payment instruction.
DAPR_SOURCE_TO_CATALOG_SOURCE = {
    "payment-engine": "go_payment_engine",
    "risk-compliance-core": "rust_risk",
}


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
    if event_type not in {PAYMENT_ORDER_VALIDATED_EVENT, POLICY_DECISION_EVENT, PAYMENT_ORDER_WORKFLOW_RECORDED_EVENT, PERMIFY_DECISION_EVENT}:
        raise LifecycleEventProjectionError("lifecycle event type is not approved for analytics projection")
    payload = data.get("payload")
    if not isinstance(payload, Mapping):
        raise LifecycleEventProjectionError("lifecycle event payload is invalid")

    source_service = _clean_string(event.get("source"), "source", 255)
    catalog_source = DAPR_SOURCE_TO_CATALOG_SOURCE.get(source_service)
    if catalog_source is None:
        raise LifecycleEventProjectionError("lifecycle event source is not approved for analytics projection")
    if event_type == PAYMENT_ORDER_VALIDATED_EVENT and catalog_source != "go_payment_engine":
        raise LifecycleEventProjectionError("payment lifecycle evidence must originate from the Go payment engine")
    if event_type == PAYMENT_ORDER_WORKFLOW_RECORDED_EVENT and catalog_source != "go_payment_engine":
        raise LifecycleEventProjectionError("workflow lifecycle evidence must originate from the Go payment engine")
    if event_type == POLICY_DECISION_EVENT and catalog_source != "rust_risk":
        raise LifecycleEventProjectionError("policy lifecycle evidence must originate from the Rust risk core")

    if event_type == PAYMENT_ORDER_WORKFLOW_RECORDED_EVENT:
        catalog_source = "temporal_workflow"
    if event_type == PERMIFY_DECISION_EVENT:
        if source_service != "payment-engine":
            raise LifecycleEventProjectionError("Permify evidence must originate from the Go payment engine")
        catalog_source = "permify_authorization"

    correlation = _clean_string(data.get("correlation_id"), "correlation_id", 255)
    raw: dict[str, object] = {
        "source": catalog_source,
        "event_type": event_type,
        "observed_at": (received_at or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat(),
        "correlation_sha256": hashlib.sha256(correlation.encode("utf-8")).hexdigest(),
        "outcome": _clean_string(payload.get("status") if event_type in {PAYMENT_ORDER_VALIDATED_EVENT, PAYMENT_ORDER_WORKFLOW_RECORDED_EVENT} else payload.get("decision"), "outcome", 80).lower(),
    }
    corridor = payload.get("corridor")
    if corridor is not None:
        raw["corridor"] = corridor
    return build_catalog_evidence(raw).to_record()


def project_lifecycle_event(writer: BronzeLakehouseWriter, event: Mapping[str, Any], received_at: datetime | None = None) -> tuple[str, str]:
    """Write one idempotent redacted lifecycle-evidence record to bronze storage."""

    record = build_lifecycle_event_record(event, received_at)
    _digest, locator = write_catalog_evidence(writer, record)
    key, status = locator.rsplit(":", 1)
    return key, status
