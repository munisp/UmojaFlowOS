"""Remittance engine behaviour: caps, rate locks, AML signals, lifecycle."""
from __future__ import annotations

import sys
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from umojaflowos_remittance_bdc.domain import (
    CASH_PICKUP_CAP_USD_CENTS, SINGLE_TXN_CAP_USD_CENTS, Beneficiary, Corridor,
    PolicyViolation, PurposeCode, RemittanceOrder, RemittanceState, Remitter, PayoutChannel,
)
from umojaflowos_remittance_bdc.remittance import RemittanceEngine, cbn_imto_daily_return

SHA = "a" * 64


def make_order(channel=PayoutChannel.BANK_CREDIT, amount=500_00):
    return RemittanceOrder(
        remittance_id="REM-001", corridor=Corridor.US_NG,
        remitter=Remitter("R1", "KYC-1", "US", 3),
        beneficiary=Beneficiary("B1", "Adaeze Okafor", "NG", "058", "tok_nubin_123", None, SHA),
        purpose=PurposeCode.FAMILY_SUPPORT, send_amount_minor=amount,
        send_currency="USD", receive_amount_minor=None, receive_currency="NGN",
        payout_channel=channel,
    )


def test_submit_happy_path_reaches_screening():
    eng = RemittanceEngine()
    order = eng.submit(make_order(), actor="op-1", screening_case_id="CASE-1")
    assert order.state == RemittanceState.SCREENING
    assert order.screening_case_id == "CASE-1"


def test_cash_pickup_requires_beneficiary_verification():
    eng = RemittanceEngine()
    order = make_order(channel=PayoutChannel.CASH_PICKUP)
    order = RemittanceOrder(**{**order.__dict__, "beneficiary": Beneficiary("B1", "Adaeze Okafor", "NG", None, None, None, None)})
    with pytest.raises(PolicyViolation, match="verification evidence"):
        eng.submit(order, actor="op-1", screening_case_id="CASE-1")


def test_bank_credit_requires_bank_details():
    eng = RemittanceEngine()
    order = make_order()
    order = RemittanceOrder(**{**order.__dict__, "beneficiary": Beneficiary("B1", "A O", "NG", None, None, None, SHA)})
    with pytest.raises(PolicyViolation, match="bank details"):
        eng.submit(order, actor="op-1", screening_case_id="CASE-1")


def test_single_transaction_cap_enforced():
    eng = RemittanceEngine()
    with pytest.raises(PolicyViolation, match="per-transaction cap"):
        eng.check_caps(make_order(amount=SINGLE_TXN_CAP_USD_CENTS + 1), SINGLE_TXN_CAP_USD_CENTS + 1, 0, 0)


def test_cash_pickup_channel_cap_enforced():
    eng = RemittanceEngine()
    order = make_order(channel=PayoutChannel.CASH_PICKUP)
    with pytest.raises(PolicyViolation, match="cash-channel cap"):
        eng.check_caps(order, CASH_PICKUP_CAP_USD_CENTS + 1, 0, 0)


def test_rolling_caps_raise_review_triggers_not_blocks():
    eng = RemittanceEngine()
    triggers = eng.check_caps(make_order(), 500_00, sender_last_24h_usd_minor=24_900_00,
                              beneficiary_last_30d_usd_minor=0)
    assert any("24h cap" in t for t in triggers)


def test_rate_lock_expiry_prevents_stale_execution():
    eng = RemittanceEngine()
    lock = eng.create_rate_lock("REM-001", Decimal("1550.25"), actor="op-1")
    lock["expires_at"] = (lock["expires_at"][:0] or lock["expires_at"])  # no-op guard
    # force expiry
    from umojaflowos_remittance_bdc.domain import utcnow
    lock["expires_at"] = (utcnow() - timedelta(seconds=1)).isoformat()
    with pytest.raises(PolicyViolation, match="rate lock expired"):
        eng.consume_rate_lock(make_order(), lock["rate_lock_id"])


def test_full_lifecycle_to_partner_finality():
    eng = RemittanceEngine()
    order = eng.submit(make_order(), actor="op-1", screening_case_id="CASE-1")
    eng.screening_cleared(order, actor="op-2", review_triggers=[])
    assert order.state == RemittanceState.RATE_LOCKED
    lock = eng.create_rate_lock(order.remittance_id, Decimal("1550.25"), actor="op-1")
    eng.approve_for_payout_preparation(order, actor="op-3", rate_lock_id=lock["rate_lock_id"])
    assert order.state == RemittanceState.APPROVED_FOR_PAYOUT_PREPARATION
    evidence = eng.record_payout_evidence(order, actor="op-4", evidence_sha256="b" * 64, reference="NIP-993")
    assert evidence["platform_execution"] is False
    eng.record_partner_finality(order, actor="op-5", partner_reference="IMTO-777")
    assert order.state == RemittanceState.COMPLETED_BY_PARTNER


def test_invalid_transition_rejected():
    eng = RemittanceEngine()
    order = eng.submit(make_order(), actor="op-1", screening_case_id="CASE-1")
    with pytest.raises(Exception, match="not a permitted"):
        order.transition(RemittanceState.COMPLETED_BY_PARTNER, "op", "skip")


def test_review_requires_rationale():
    eng = RemittanceEngine()
    order = eng.submit(make_order(), actor="op-1", screening_case_id="CASE-1")
    eng.screening_cleared(order, actor="op-2", review_triggers=["sender rolling 24h cap exceeded"])
    assert order.state == RemittanceState.REVIEW_REQUIRED
    with pytest.raises(PolicyViolation, match="rationale"):
        eng.human_review_decision(order, actor="rev-1", approved=True, rationale="  ")


def test_structuring_and_smurfing_signals():
    eng = RemittanceEngine()
    assert eng.structuring_signal([9_000_00, 9_000_00, 9_000_00]) is not None
    assert eng.structuring_signal([9_000_00]) is None
    assert eng.smurfing_signal(distinct_senders=4, shared_beneficiary=True) is not None
    assert eng.smurfing_signal(distinct_senders=2, shared_beneficiary=True) is None
    assert eng.cash_reporting_signal(5_500_000_00) is not None


def test_imto_daily_return_prepared_not_submitted():
    eng = RemittanceEngine()
    order = eng.submit(make_order(), actor="op-1", screening_case_id="CASE-1")
    day = order.created_at.date().isoformat()
    report = cbn_imto_daily_return(list(eng.orders.values()), day)
    assert report["prepared"] is True and report["submitted"] is False
    assert report["corridors"]["US_NG"]["count"] == 1
    assert "platform evidence only" in report["submission_boundary"]
