"""Regulatory report assembly for CBN, CBK, and SARB.

This module constructs a submission-ready report artifact from canonical
transaction records. It is deliberately not a template renderer: every total is
recomputed from the supplied rows, and any row that fails the regulator's field
requirements aborts assembly rather than being silently dropped or defaulted.

The artifact carries its own integrity digest and a per-row inclusion ledger so
a reviewer can reconcile the assembled totals against the source records. The
module performs no submission and asserts no regulator connectivity: the
returned artifact is explicitly marked as requiring an authorised channel
reference before any submission may be recorded.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from hashlib import sha256
from typing import Mapping, Sequence

from .reporting import REQUIRED_BY_REGULATOR, ReportValidationError

CORRIDOR_BY_REGULATOR = {
    "CBN": ("Nigeria", "NGN"),
    "CBK": ("Kenya", "KES"),
    "SARB": ("South Africa", "ZAR"),
}

REQUIRED_TRANSACTION_FIELDS = (
    "transaction_reference",
    "value_date",
    "currency",
    "amount",
    "counterparty_reference",
    "direction",
)

VALID_DIRECTIONS = ("INBOUND", "OUTBOUND")


class ReportAssemblyError(ValueError):
    """Raised when a report cannot be assembled from the supplied records."""


@dataclass(frozen=True)
class AssembledRow:
    transaction_reference: str
    value_date: str
    currency: str
    amount: str
    direction: str
    counterparty_reference: str


@dataclass(frozen=True)
class ReportTotals:
    record_count: int
    inbound_total: str
    outbound_total: str
    net_total: str


@dataclass(frozen=True)
class AssembledReport:
    regulator: str
    corridor: str
    settlement_currency: str
    report_type: str
    period_start: str
    period_end: str
    regulated_entity_id: str
    generated_at: str
    totals: ReportTotals
    rows: tuple[AssembledRow, ...]
    artifact_digest: str
    submission_state: str


def _parse_date(value: object, label: str) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    try:
        return date.fromisoformat(str(value))
    except ValueError as error:
        raise ReportAssemblyError(f"{label} must be an ISO-8601 date") from error


def _parse_amount(value: object, reference: str) -> Decimal:
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, TypeError) as error:
        raise ReportAssemblyError(f"transaction {reference} has a non-decimal amount") from error
    if amount.is_nan() or amount.is_infinite():
        raise ReportAssemblyError(f"transaction {reference} amount must be finite")
    if amount <= 0:
        raise ReportAssemblyError(f"transaction {reference} amount must be greater than zero")
    return amount


def assemble_regulatory_report(
    *,
    regulator: str,
    report_type: str,
    period_start: object,
    period_end: object,
    regulated_entity_id: str,
    transactions: Sequence[Mapping[str, object]],
    generated_at: datetime | None = None,
) -> AssembledReport:
    """Assemble a CBN, CBK, or SARB report artifact from canonical records."""
    normalised = regulator.upper()
    if normalised not in REQUIRED_BY_REGULATOR:
        raise ReportAssemblyError("regulator must be CBN, CBK, or SARB")
    corridor, settlement_currency = CORRIDOR_BY_REGULATOR[normalised]

    if not report_type or len(report_type.strip()) < 4:
        raise ReportAssemblyError("report_type is required")
    if not regulated_entity_id.strip():
        raise ReportAssemblyError("regulated_entity_id is required")

    start = _parse_date(period_start, "period_start")
    end = _parse_date(period_end, "period_end")
    if end < start:
        raise ReportAssemblyError("period_end cannot precede period_start")

    if not transactions:
        raise ReportAssemblyError("no canonical transaction records were supplied")

    rows: list[AssembledRow] = []
    seen: set[str] = set()
    inbound = Decimal("0")
    outbound = Decimal("0")

    for index, record in enumerate(transactions):
        missing = [field for field in REQUIRED_TRANSACTION_FIELDS if field not in record]
        if missing:
            raise ReportAssemblyError(
                f"transaction at index {index} is missing required fields: {', '.join(sorted(missing))}"
            )
        reference = str(record["transaction_reference"]).strip()
        if not reference:
            raise ReportAssemblyError(f"transaction at index {index} has an empty reference")
        if reference in seen:
            raise ReportAssemblyError(f"duplicate transaction reference: {reference}")
        seen.add(reference)

        currency = str(record["currency"]).upper()
        if currency != settlement_currency:
            raise ReportAssemblyError(
                f"transaction {reference} currency {currency} does not match the {normalised} settlement currency {settlement_currency}"
            )

        direction = str(record["direction"]).upper()
        if direction not in VALID_DIRECTIONS:
            raise ReportAssemblyError(f"transaction {reference} direction must be INBOUND or OUTBOUND")

        value_date = _parse_date(record["value_date"], f"transaction {reference} value_date")
        if value_date < start or value_date > end:
            raise ReportAssemblyError(
                f"transaction {reference} value date {value_date.isoformat()} falls outside the reporting period"
            )

        counterparty = str(record["counterparty_reference"]).strip()
        if not counterparty:
            raise ReportAssemblyError(f"transaction {reference} requires a counterparty reference")

        amount = _parse_amount(record["amount"], reference)
        if direction == "INBOUND":
            inbound += amount
        else:
            outbound += amount

        rows.append(
            AssembledRow(
                transaction_reference=reference,
                value_date=value_date.isoformat(),
                currency=currency,
                amount=str(amount),
                direction=direction,
                counterparty_reference=counterparty,
            )
        )

    ordered = tuple(sorted(rows, key=lambda row: (row.value_date, row.transaction_reference)))
    totals = ReportTotals(
        record_count=len(ordered),
        inbound_total=str(inbound),
        outbound_total=str(outbound),
        net_total=str(inbound - outbound),
    )

    body = {
        "regulator": normalised,
        "corridor": corridor,
        "settlement_currency": settlement_currency,
        "report_type": report_type.strip(),
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "regulated_entity_id": regulated_entity_id.strip(),
        "totals": asdict(totals),
        "rows": [asdict(row) for row in ordered],
    }
    digest = sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()

    return AssembledReport(
        regulator=normalised,
        corridor=corridor,
        settlement_currency=settlement_currency,
        report_type=report_type.strip(),
        period_start=start.isoformat(),
        period_end=end.isoformat(),
        regulated_entity_id=regulated_entity_id.strip(),
        generated_at=(generated_at or datetime.now(timezone.utc)).isoformat(),
        totals=totals,
        rows=ordered,
        artifact_digest=digest,
        submission_state="requires_authorised_channel_reference",
    )


def validate_assembled_report(report: AssembledReport) -> None:
    """Re-verify an assembled artifact's integrity digest and totals."""
    recomputed = assemble_regulatory_report(
        regulator=report.regulator,
        report_type=report.report_type,
        period_start=report.period_start,
        period_end=report.period_end,
        regulated_entity_id=report.regulated_entity_id,
        transactions=[asdict(row) for row in report.rows],
        generated_at=datetime.fromisoformat(report.generated_at),
    )
    if recomputed.artifact_digest != report.artifact_digest:
        raise ReportValidationError("assembled report digest does not match its contents")
    if recomputed.totals != report.totals:
        raise ReportValidationError("assembled report totals do not match its rows")
