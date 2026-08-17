from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from typing import Iterable, Mapping


class ReportValidationError(ValueError):
    pass


REQUIRED_BY_REGULATOR = {
    "CBN": {"corridor", "report_type", "period_start", "period_end", "regulated_entity_id", "transactions"},
    "CBK": {"corridor", "report_type", "period_start", "period_end", "regulated_entity_id", "transactions"},
    "SARB": {"corridor", "report_type", "period_start", "period_end", "regulated_entity_id", "transactions"},
}


@dataclass(frozen=True)
class EvidenceManifest:
    regulator: str
    source_hash: str
    generated_at: str
    record_count: int


def validate_report_pack(pack: Mapping[str, object]) -> None:
    regulator = str(pack.get("regulator", "")).upper()
    if regulator not in REQUIRED_BY_REGULATOR:
        raise ReportValidationError("regulator must be CBN, CBK, or SARB")
    missing = [field for field in REQUIRED_BY_REGULATOR[regulator] if field not in pack]
    if missing:
        raise ReportValidationError(f"missing required report fields: {', '.join(sorted(missing))}")
    corridor = str(pack["corridor"])
    if corridor not in {"Nigeria", "Kenya", "South Africa"}:
        raise ReportValidationError("corridor must be Nigeria, Kenya, or South Africa")
    transactions = pack["transactions"]
    if not isinstance(transactions, Iterable) or isinstance(transactions, (str, bytes, dict)):
        raise ReportValidationError("transactions must be a sequence of validated transaction records")


def build_evidence_manifest(regulator: str, canonical_payload: bytes, record_count: int) -> EvidenceManifest:
    if regulator.upper() not in REQUIRED_BY_REGULATOR:
        raise ReportValidationError("regulator must be CBN, CBK, or SARB")
    if record_count < 0:
        raise ReportValidationError("record_count cannot be negative")
    return EvidenceManifest(
        regulator=regulator.upper(),
        source_hash=sha256(canonical_payload).hexdigest(),
        generated_at=datetime.now(timezone.utc).isoformat(),
        record_count=record_count,
    )
