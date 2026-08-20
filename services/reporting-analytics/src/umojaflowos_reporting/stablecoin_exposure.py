"""Stablecoin exposure reporting for USDC and USDT across the NGN, KES, and ZAR corridors.

Every figure in the output is derived arithmetically from reconciled position
records supplied by the caller. This module never fetches a rate, never
interpolates a missing balance, and never substitutes a default: if a position
lacks a reconciliation timestamp, a source reference, or a peg observation for
its asset, the report fails closed with an explicit reason instead of producing
a partial exposure figure that could be mistaken for a reconciled total.

Peg deviation is reported as an observation, not as a valuation adjustment. The
module deliberately produces no accounting entry and no rebalancing instruction.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Mapping, Sequence

SUPPORTED_STABLECOINS = ("USDC", "USDT")
SUPPORTED_CORRIDORS = ("NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR")


class ExposureReportError(ValueError):
    """Raised when exposure cannot be computed from the supplied evidence."""


@dataclass(frozen=True)
class StablecoinPosition:
    """A reconciled stablecoin position. All fields are required evidence."""

    corridor: str
    asset: str
    account_reference: str
    available_amount: Decimal
    reserved_amount: Decimal
    source_reference: str
    reconciled_at: datetime


@dataclass(frozen=True)
class PegObservation:
    """An observed stablecoin-to-USD rate with its own provenance."""

    asset: str
    rate_to_usd: Decimal
    source_reference: str
    observed_at: datetime


@dataclass(frozen=True)
class CorridorExposure:
    corridor: str
    asset: str
    available_amount: Decimal
    reserved_amount: Decimal
    total_amount: Decimal
    usd_equivalent: Decimal
    peg_deviation_basis_points: int
    position_count: int
    source_references: tuple[str, ...]


@dataclass(frozen=True)
class ExposureReport:
    generated_at: datetime
    corridor_exposures: tuple[CorridorExposure, ...]
    total_usd_equivalent: Decimal
    observations: tuple[str, ...] = field(default=())


def _require_decimal(value: object, label: str) -> Decimal:
    if isinstance(value, Decimal):
        candidate = value
    else:
        try:
            candidate = Decimal(str(value))
        except (InvalidOperation, TypeError) as error:
            raise ExposureReportError(f"{label} is not a decimal amount") from error
    if candidate.is_nan() or candidate.is_infinite():
        raise ExposureReportError(f"{label} must be a finite amount")
    if candidate < 0:
        raise ExposureReportError(f"{label} cannot be negative")
    return candidate


def _validate_position(position: StablecoinPosition) -> None:
    if position.corridor not in SUPPORTED_CORRIDORS:
        raise ExposureReportError(f"unsupported corridor: {position.corridor}")
    if position.asset not in SUPPORTED_STABLECOINS:
        raise ExposureReportError(f"unsupported stablecoin: {position.asset}")
    if not position.source_reference.strip():
        raise ExposureReportError("each position requires a source reference")
    if not position.account_reference.strip():
        raise ExposureReportError("each position requires an account reference")
    if position.reconciled_at.tzinfo is None:
        raise ExposureReportError("reconciled_at must be timezone-aware")
    _require_decimal(position.available_amount, "available_amount")
    _require_decimal(position.reserved_amount, "reserved_amount")


def _validate_observation(observation: PegObservation) -> None:
    if observation.asset not in SUPPORTED_STABLECOINS:
        raise ExposureReportError(f"unsupported stablecoin: {observation.asset}")
    if not observation.source_reference.strip():
        raise ExposureReportError("each peg observation requires a source reference")
    if observation.observed_at.tzinfo is None:
        raise ExposureReportError("observed_at must be timezone-aware")
    rate = _require_decimal(observation.rate_to_usd, "rate_to_usd")
    if rate == 0:
        raise ExposureReportError("rate_to_usd must be greater than zero")


def build_stablecoin_exposure_report(
    positions: Sequence[StablecoinPosition],
    peg_observations: Mapping[str, PegObservation],
    *,
    as_of: datetime,
    max_position_age: timedelta,
    max_observation_age: timedelta,
) -> ExposureReport:
    """Aggregate reconciled positions into corridor-level exposure.

    Raises ExposureReportError when any required evidence is missing or stale.
    """
    if as_of.tzinfo is None:
        raise ExposureReportError("as_of must be timezone-aware")
    if not positions:
        raise ExposureReportError("no reconciled stablecoin positions were supplied")

    buckets: dict[tuple[str, str], list[StablecoinPosition]] = {}
    for position in positions:
        _validate_position(position)
        if position.reconciled_at > as_of:
            raise ExposureReportError(
                f"position {position.account_reference} has a reconciliation timestamp after the report cutoff"
            )
        if as_of - position.reconciled_at > max_position_age:
            raise ExposureReportError(
                f"position {position.account_reference} was reconciled outside the permitted window"
            )
        buckets.setdefault((position.corridor, position.asset), []).append(position)

    exposures: list[CorridorExposure] = []
    observations: list[str] = []
    total_usd = Decimal("0")

    for (corridor, asset), bucket in sorted(buckets.items()):
        observation = peg_observations.get(asset)
        if observation is None:
            raise ExposureReportError(f"no peg observation supplied for {asset}")
        _validate_observation(observation)
        if observation.observed_at > as_of:
            raise ExposureReportError(f"peg observation for {asset} is after the report cutoff")
        if as_of - observation.observed_at > max_observation_age:
            raise ExposureReportError(f"peg observation for {asset} is stale")

        available = sum((p.available_amount for p in bucket), Decimal("0"))
        reserved = sum((p.reserved_amount for p in bucket), Decimal("0"))
        total = available + reserved
        usd_equivalent = total * observation.rate_to_usd
        # Deviation from the 1.00 USD peg, in basis points, as an observation.
        deviation_bps = int(((observation.rate_to_usd - Decimal("1")) * Decimal("10000")).to_integral_value())
        if deviation_bps != 0:
            observations.append(
                f"{asset} observed at {observation.rate_to_usd} USD ({deviation_bps} bps from peg) per {observation.source_reference}"
            )

        exposures.append(
            CorridorExposure(
                corridor=corridor,
                asset=asset,
                available_amount=available,
                reserved_amount=reserved,
                total_amount=total,
                usd_equivalent=usd_equivalent,
                peg_deviation_basis_points=deviation_bps,
                position_count=len(bucket),
                source_references=tuple(sorted({p.source_reference for p in bucket})),
            )
        )
        total_usd += usd_equivalent

    return ExposureReport(
        generated_at=as_of,
        corridor_exposures=tuple(exposures),
        total_usd_equivalent=total_usd,
        observations=tuple(observations),
    )


def utc(*args: int) -> datetime:
    """Small helper for constructing timezone-aware UTC datetimes."""
    return datetime(*args, tzinfo=timezone.utc)
