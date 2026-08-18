"""Regressions for CBN/CBK/SARB regulatory report assembly."""
from datetime import datetime, timezone

import pytest

from umojaflowos_reporting.assembly import (
    ReportAssemblyError,
    assemble_regulatory_report,
    validate_assembled_report,
)

GENERATED_AT = datetime(2026, 8, 18, 12, 0, tzinfo=timezone.utc)


def txn(ref="TXN-1", amount="100.00", direction="INBOUND", currency="NGN", value_date="2026-07-15"):
    return {
        "transaction_reference": ref,
        "value_date": value_date,
        "currency": currency,
        "amount": amount,
        "counterparty_reference": "CP-1",
        "direction": direction,
    }


def assemble(regulator="CBN", transactions=None, **overrides):
    kwargs = {
        "regulator": regulator,
        "report_type": "monthly-cross-border-settlement",
        "period_start": "2026-07-01",
        "period_end": "2026-07-31",
        "regulated_entity_id": "ENTITY-1",
        "transactions": transactions if transactions is not None else [txn()],
        "generated_at": GENERATED_AT,
    }
    kwargs.update(overrides)
    return assemble_regulatory_report(**kwargs)


def test_assembles_totals_from_rows_rather_than_trusting_supplied_totals():
    report = assemble(
        transactions=[
            txn("TXN-1", "100.00", "INBOUND"),
            txn("TXN-2", "40.50", "OUTBOUND"),
            txn("TXN-3", "9.50", "OUTBOUND"),
        ]
    )
    assert report.totals.record_count == 3
    assert report.totals.inbound_total == "100.00"
    assert report.totals.outbound_total == "50.00"
    assert report.totals.net_total == "50.00"


def test_binds_each_regulator_to_its_corridor_and_settlement_currency():
    assert assemble("CBN").settlement_currency == "NGN"
    assert assemble("CBK", transactions=[txn(currency="KES")]).settlement_currency == "KES"
    assert assemble("SARB", transactions=[txn(currency="ZAR")]).settlement_currency == "ZAR"
    assert assemble("CBK", transactions=[txn(currency="KES")]).corridor == "Kenya"


def test_rejects_a_currency_that_does_not_match_the_regulator():
    with pytest.raises(ReportAssemblyError, match="does not match"):
        assemble("CBN", transactions=[txn(currency="KES")])


def test_rejects_a_transaction_outside_the_reporting_period():
    with pytest.raises(ReportAssemblyError, match="outside the reporting period"):
        assemble(transactions=[txn(value_date="2026-08-02")])


def test_rejects_duplicate_transaction_references():
    with pytest.raises(ReportAssemblyError, match="duplicate transaction reference"):
        assemble(transactions=[txn("TXN-1"), txn("TXN-1")])


def test_rejects_missing_required_transaction_fields_instead_of_dropping_the_row():
    incomplete = txn()
    del incomplete["counterparty_reference"]
    with pytest.raises(ReportAssemblyError, match="missing required fields"):
        assemble(transactions=[incomplete])


def test_rejects_non_positive_and_non_finite_amounts():
    with pytest.raises(ReportAssemblyError, match="greater than zero"):
        assemble(transactions=[txn(amount="0")])
    with pytest.raises(ReportAssemblyError, match="finite"):
        assemble(transactions=[txn(amount="NaN")])


def test_rejects_an_inverted_period_and_an_empty_record_set():
    with pytest.raises(ReportAssemblyError, match="cannot precede"):
        assemble(period_start="2026-07-31", period_end="2026-07-01")
    with pytest.raises(ReportAssemblyError, match="no canonical transaction records"):
        assemble(transactions=[])


def test_digest_is_deterministic_and_changes_when_any_row_changes():
    first = assemble(transactions=[txn("TXN-1"), txn("TXN-2", "5.00")])
    same = assemble(transactions=[txn("TXN-2", "5.00"), txn("TXN-1")])
    assert first.artifact_digest == same.artifact_digest, "row order must not change the digest"
    changed = assemble(transactions=[txn("TXN-1"), txn("TXN-2", "5.01")])
    assert changed.artifact_digest != first.artifact_digest


def test_assembled_report_verifies_against_its_own_digest():
    report = assemble(transactions=[txn("TXN-1"), txn("TXN-2", "5.00", "OUTBOUND")])
    validate_assembled_report(report)


def test_assembled_report_is_never_marked_submitted():
    report = assemble()
    assert report.submission_state == "requires_authorised_channel_reference"
