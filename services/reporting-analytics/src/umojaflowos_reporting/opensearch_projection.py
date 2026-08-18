from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping


class SearchProjectionError(ValueError):
    pass


FORBIDDEN_FIELDS = {"amount", "balance", "account_number", "wallet_address", "document_bytes", "access_token", "secret"}


@dataclass(frozen=True)
class AuditProjection:
    index: str
    document_id: str
    document: dict[str, object]


def build_audit_projection(event: Mapping[str, object]) -> AuditProjection:
    required = ("event_id", "action", "object_type", "occurred_at")
    if any(not isinstance(event.get(key), str) or not str(event[key]).strip() for key in required):
        raise SearchProjectionError("event identity, action, object type, and timestamp are required")
    metadata = event.get("metadata", {})
    if not isinstance(metadata, Mapping) or any(key in FORBIDDEN_FIELDS for key in metadata):
        raise SearchProjectionError("audit projection contains forbidden monetary or secret data")
    return AuditProjection(index="umojaflowos-audit-v1", document_id=str(event["event_id"]), document={"event_id": event["event_id"], "action": event["action"], "object_type": event["object_type"], "occurred_at": event["occurred_at"], "metadata": dict(metadata)})
