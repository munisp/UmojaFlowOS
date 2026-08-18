"""Regressions for stablecoin exposure reporting.

These assert exact decimal arithmetic and prove that every missing or stale
piece of evidence fails closed rather than producing a partial total.
"""
from datetime import timedelta
from decimal import Decimal

import pytest

from umojaflowos_reporting.stablecoin_exposure import (
    ExposureReportError,
    PegObservation,
    StablecoinPosition,
    build_stablecoin_exposure_report,
    utc,
)

AS_OF = utc(2026, 8, 18, 12, 0, 0)
MAX_POSITION_AGE = timedelta(hours=24)
MAX_OBSERVATION_AGE = timedelta(minutes=30)


def position(corridor="NIGERIA_NGN", asset="USDC", available="1000.00", reserved="250.00", minutes_old=5):
    return StablecoinPosition(
        corridor=corridor,
        asset=asset,
        account_reference=f"{corridor}-{asset}-CUSTODY-1",
        available_amount=Decimal(available),
        reserved_amount=Decimal(reserved),
        source_reference=f"custody-statement-{corridor}-{asset}",
        reconciled_at=AS_OF - timedelta(minutes=minutes_old),
    )


def observation(asset="USDC", rate="1.0000", minutes_old=2):
    return PegObservation(
        asset=asset,
        rate_to_usd=Decimal(rate),
        source_reference=f"market-data-{asset}",
        observed_at=AS_OF - timedelta(minutes=minutes_old),
    )


def build(positions, observations, **overrides):
    kwargs = {
        "as_of": AS_OF,
        "max_position_age": MAX_POSITION_AGE,
        "max_observation_age": MAX_OBSERVATION_AGE,
    }
    kwargs.update(overrides)
    return build_stablecoin_exposure_report(positions, observations, **kwargs)


def test_aggregates_positions_per_corridor_and_asset_with_exact_arithmetic():
    report = build(
        [
            position(available="1000.00", reserved="250.00"),
            position(available="500.50", reserved="0.50"),
            position(corridor="KENYA_KES", asset="USDT", available="2000.00", reserved="0.00"),
        ],
        {"USDC": observation("USDC", "1.0000"), "USDT": observation("USDT", "1.0000")},
    )
    by_key = {(e.corridor, e.asset): e for e in report.corridor_exposures}
    ngn_usdc = by_key[("NIGERIA_NGN", "USDC")]
    assert ngn_usdc.available_amount == Decimal("1500.50")
    assert ngn_usdc.reserved_amount == Decimal("250.50")
    assert ngn_usdc.total_amount == Decimal("1751.00")
    assert ngn_usdc.position_count == 2
    assert report.total_usd_equivalent == Decimal("3751.0000")


def test_reports_peg_deviation_as_an_observation_not_an_adjustment():
    report = build([position()], {"USDC": observation("USDC", "0.9985")})
    exposure = report.corridor_exposures[0]
    assert exposure.peg_deviation_basis_points == -15
    assert exposure.usd_equivalent == Decimal("1250.00") * Decimal("0.9985")
    assert any("bps from peg" in note for note in report.observations)


def test_fails_closed_when_no_peg_observation_exists_for_a_held_asset():
    with pytest.raises(ExposureReportError, match="no peg observation supplied for USDT"):
        build([position(asset="USDT")], {"USDC": observation("USDC")})


def test_fails_closed_on_a_stale_peg_observation():
    with pytest.raises(ExposureReportError, match="stale"):
        build([position()], {"USDC": observation("USDC", minutes_old=45)})


def test_fails_closed_on_a_position_reconciled_outside_the_window():
    with pytest.raises(ExposureReportError, match="reconciled outside the permitted window"):
        build([position(minutes_old=60 * 30)], {"USDC": observation("USDC")})


def test_fails_closed_when_no_positions_are_supplied():
    with pytest.raises(ExposureReportError, match="no reconciled stablecoin positions"):
        build([], {"USDC": observation("USDC")})


def test_rejects_unsupported_assets_and_corridors():
    with pytest.raises(ExposureReportError, match="unsupported stablecoin"):
        build([position(asset="DAI")], {"USDC": observation("USDC")})
    with pytest.raises(ExposureReportError, match="unsupported corridor"):
        build([position(corridor="GHANA_GHS")], {"USDC": observation("USDC")})


def test_rejects_a_position_without_a_source_reference():
    bad = StablecoinPosition(
        corridor="NIGERIA_NGN",
        asset="USDC",
        account_reference="acct-1",
        available_amount=Decimal("1"),
        reserved_amount=Decimal("0"),
        source_reference="   ",
        reconciled_at=AS_OF,
    )
    with pytest.raises(ExposureReportError, match="requires a source reference"):
        build([bad], {"USDC": observation("USDC")})


def test_rejects_negative_and_non_finite_amounts():
    with pytest.raises(ExposureReportError, match="cannot be negative"):
        build([position(available="-1.00")], {"USDC": observation("USDC")})
    with pytest.raises(ExposureReportError, match="finite"):
        build([position(available="NaN")], {"USDC": observation("USDC")})


def test_rejects_a_zero_or_negative_peg_rate():
    with pytest.raises(ExposureReportError, match="greater than zero"):
        build([position()], {"USDC": observation("USDC", "0")})
    with pytest.raises(ExposureReportError, match="cannot be negative"):
        build([position()], {"USDC": observation("USDC", "-1")})


def test_report_carries_provenance_and_no_rebalancing_instruction():
    report = build([position()], {"USDC": observation("USDC")})
    exposure = report.corridor_exposures[0]
    assert exposure.source_references == ("custody-statement-NIGERIA_NGN-USDC",)
    # The report must not expose anything that reads as an execution instruction.
    for forbidden in ("instruction", "transfer", "rebalance", "execute"):
        assert not any(forbidden in name for name in vars(exposure))
