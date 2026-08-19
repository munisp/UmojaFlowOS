"""Governed cross-service evidence catalog for the UmojaFlowOS lakehouse.

This is intentionally a projection contract, not an operational event bus or a
second ledger. PostgreSQL remains the operational and compliance record;
TigerBeetle remains the confirmed double-entry record when activated. This
module permits those systems, workflows, policy engines, and provider adapters
to contribute only redacted, hashed, non-authoritative evidence suitable for
approved analytics and model features.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import re
from typing import Literal, Mapping

from .lakehouse import LakehouseContractError
from .lakehouse_writer import BronzeLakehouseWriter


CatalogSource = Literal[
    "postgresql_control",
    "tigerbeetle_reconciliation",
    "temporal_workflow",
    "permify_authorization",
    "rust_risk",
    "ai_ml_evidence",
    "stablecoin_exposure",
    "provider_lifecycle",
    "service_health",
]

CATALOG_SOURCES: frozenset[str] = frozenset(
    {
        "postgresql_control",
        "tigerbeetle_reconciliation",
        "temporal_workflow",
        "permify_authorization",
        "rust_risk",
        "ai_ml_evidence",
        "stablecoin_exposure",
        "provider_lifecycle",
        "service_health",
    }
)

CORRIDORS = frozenset({"NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"})
STABLECOINS = frozenset({"USDC", "USDT"})
SHA256 = re.compile(r"^[a-f0-9]{64}$")
FORBIDDEN_EVENT_FIELD = re.compile(
    r"(?:secret|token|password|credential|private|customer|beneficiar|account|wallet|document|payload|base64|latitude|longitude|execute|transfer|payout|accept_quote|settle)",
    re.I,
)
ALLOWED_EVENT_FIELDS = frozenset(
    {
        "source",
        "event_type",
        "observed_at",
        "correlation_sha256",
        "outcome",
        "corridor",
        "stablecoin",
        "model_role",
    }
)


@dataclass(frozen=True)
class CatalogEvidence:
    source: CatalogSource
    event_type: str
    observed_at: datetime
    correlation_sha256: str
    outcome: str
    corridor: str | None = None
    stablecoin: str | None = None
    model_role: str | None = None

    def to_record(self) -> dict[str, object]:
        record: dict[str, object] = {
            "schema_version": "v1",
            "source": self.source,
            "event_type": self.event_type,
            "observed_at": self.observed_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
            "correlation_sha256": self.correlation_sha256,
            "outcome": self.outcome,
            "authoritative": False,
        }
        if self.corridor is not None:
            record["corridor"] = self.corridor
        if self.stablecoin is not None:
            record["stablecoin"] = self.stablecoin
        if self.model_role is not None:
            record["model_role"] = self.model_role
        return record


def build_catalog_evidence(raw: Mapping[str, object]) -> CatalogEvidence:
    """Validate an analytics-safe cross-service projection.

    The caller must hash its native correlation identifier before this boundary.
    That makes it impossible for this contract to become an unnoticed replication
    path for payment IDs, customer IDs, wallets, account numbers, or provider
    sequence values.
    """

    for key in raw:
        if not isinstance(key, str) or key not in ALLOWED_EVENT_FIELDS or FORBIDDEN_EVENT_FIELD.search(key):
            raise LakehouseContractError("lakehouse catalog evidence contains an unapproved identifying, credential, location, or execution field")

    source = raw.get("source")
    event_type = raw.get("event_type")
    observed_at = raw.get("observed_at")
    correlation = raw.get("correlation_sha256")
    outcome = raw.get("outcome")
    if not isinstance(source, str) or source not in CATALOG_SOURCES:
        raise LakehouseContractError("lakehouse catalog source is not approved")
    if not isinstance(event_type, str) or not re.fullmatch(r"[a-z][a-z0-9_.-]{2,100}", event_type):
        raise LakehouseContractError("lakehouse catalog event type is invalid")
    if not isinstance(correlation, str) or not SHA256.fullmatch(correlation):
        raise LakehouseContractError("lakehouse catalog requires a SHA-256 correlation reference")
    if not isinstance(outcome, str) or not re.fullmatch(r"[a-z][a-z0-9_.-]{1,80}", outcome):
        raise LakehouseContractError("lakehouse catalog outcome is invalid")
    if not isinstance(observed_at, str):
        raise LakehouseContractError("lakehouse catalog observation time is required")
    try:
        parsed_observed_at = datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise LakehouseContractError("lakehouse catalog observation time is invalid") from exc
    if parsed_observed_at.tzinfo is None:
        raise LakehouseContractError("lakehouse catalog observation time must include a timezone")

    corridor = raw.get("corridor")
    if corridor is not None and (not isinstance(corridor, str) or corridor not in CORRIDORS):
        raise LakehouseContractError("lakehouse catalog corridor is not supported")
    stablecoin = raw.get("stablecoin")
    if stablecoin is not None and (not isinstance(stablecoin, str) or stablecoin not in STABLECOINS):
        raise LakehouseContractError("lakehouse catalog stablecoin must be USDC or USDT")
    model_role = raw.get("model_role")
    if model_role is not None and (not isinstance(model_role, str) or not re.fullmatch(r"[a-z][a-z0-9_.-]{2,80}", model_role)):
        raise LakehouseContractError("lakehouse catalog model role is invalid")

    return CatalogEvidence(
        source=source,  # type: ignore[arg-type]
        event_type=event_type,
        observed_at=parsed_observed_at,
        correlation_sha256=correlation,
        outcome=outcome,
        corridor=corridor,
        stablecoin=stablecoin,
        model_role=model_role,
    )


def write_catalog_evidence(writer: BronzeLakehouseWriter, raw: Mapping[str, object]) -> tuple[str, str]:
    evidence = build_catalog_evidence(raw)
    manifest, key, disposition = writer.write("payment-lifecycle-evidence", [evidence.to_record()])
    # Deliberately return only non-sensitive object metadata. The manifest digest
    # allows an approved reader to verify immutable object identity.
    return manifest.payload_sha256, f"{key}:{disposition}"
