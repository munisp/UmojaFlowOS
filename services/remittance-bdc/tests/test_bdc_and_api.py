"""BDC engine + API boundary tests."""
from __future__ import annotations

import sys
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from umojaflowos_remittance_bdc.bdc import BdcEngine, cbn_bdc_daily_return
from umojaflowos_remittance_bdc.domain import (
    BDC_MAX_SPREAD_BPS, BdcRateBoardEntry, BdcTicket, BdcTicketSide,
    BdcTicketState, PolicyViolation, utcnow,
)

SHA = "c" * 64


def board(spread_bps=200):
    ref = Decimal("1500.00")
    buy = ref
    sell = (ref * Decimal(10_000 + spread_bps) / Decimal(10_000)).quantize(Decimal("0.01"))
    return BdcRateBoardEntry(currency="USD", buy_rate_ngn=buy, sell_rate_ngn=sell,
                             cbn_reference_ngn=ref, band_bps=500, effective_at=utcnow(), set_by="op-1")


def ticket(side=BdcTicketSide.SELL_FX, fx=500_00, rate="1503.00", ngn=751_500_00):
    return BdcTicket(ticket_id="TKT-1", bdc_operator_id="BDC-LAG-01", branch_id="BR-IKEJA",
                     side=side, fx_currency="USD", fx_amount_minor=fx, rate_ngn=Decimal(rate),
                     ngn_amount_minor=ngn, customer_subject_id="CUST-1", id_evidence_sha256=SHA)


def test_rate_board_spread_ceiling():
    eng = BdcEngine()
    with pytest.raises(PolicyViolation, match="governance ceiling"):
        eng.publish_rate_board(board(spread_bps=BDC_MAX_SPREAD_BPS + 1))


def test_rate_board_band_breach_rejected():
    eng = BdcEngine()
    b = board()
    b = BdcRateBoardEntry(**{**b.__dict__, "band_bps": 50})  # tighter band than the 200bps spread
    with pytest.raises(PolicyViolation, match="deviates"):
        eng.publish_rate_board(b)


def test_off_board_sell_rate_rejected():
    eng = BdcEngine()
    eng.publish_rate_board(board())
    t = ticket(rate="1600.00")  # worse than board sell 1503.00
    with pytest.raises(PolicyViolation, match="off-board execution prevented"):
        eng.create_ticket(t, actor="op-1", customer_weekly_fx_usd_minor=0)


def test_weekly_customer_cap():
    eng = BdcEngine()
    eng.publish_rate_board(board())
    with pytest.raises(PolicyViolation, match="weekly retail FX cap"):
        eng.create_ticket(ticket(fx=500_00), actor="op-1",
                          customer_weekly_fx_usd_minor=4_900_00 + 200_00)


def test_missing_id_evidence_rejected():
    eng = BdcEngine()
    eng.publish_rate_board(board())
    t = ticket()
    t = BdcTicket(**{**t.__dict__, "id_evidence_sha256": "short"})
    with pytest.raises(PolicyViolation, match="ID evidence"):
        eng.create_ticket(t, actor="op-1", customer_weekly_fx_usd_minor=0)


def test_settlement_updates_vault_and_shortfall_alert():
    eng = BdcEngine()
    eng.publish_rate_board(board())
    t = eng.create_ticket(ticket(), actor="op-1", customer_weekly_fx_usd_minor=0)
    eng.approve_for_settlement_preparation(t, actor="op-2")
    eng.record_settlement_evidence(t, actor="op-3", evidence_sha256="d" * 64)
    positions = {p.currency: p.balance_minor for p in eng.vault_position("BDC-LAG-01", "BR-IKEJA")}
    assert positions["USD"] == -500_00          # sold FX depletes vault
    assert positions["NGN"] == 751_500_00
    alert = eng.negative_vault_alert("BDC-LAG-01", "BR-IKEJA")
    assert alert is not None and "USD" in alert


def test_counterfeit_flag_forces_review():
    eng = BdcEngine()
    eng.publish_rate_board(board())
    t = eng.create_ticket(ticket(), actor="op-1", customer_weekly_fx_usd_minor=0)
    eng.flag_counterfeit(t, actor="op-2", note="suspect $100 bill serial")
    assert t.counterfeit_flag and t.state == BdcTicketState.REVIEW_REQUIRED


def test_stale_board_rejected():
    from datetime import timedelta
    eng = BdcEngine()
    b = board()
    b = BdcRateBoardEntry(**{**b.__dict__, "effective_at": utcnow() - timedelta(hours=5)})
    eng.rate_boards["USD"] = b
    with pytest.raises(PolicyViolation, match="stale"):
        eng.create_ticket(ticket(), actor="op-1", customer_weekly_fx_usd_minor=0)


def test_bdc_daily_return_threshold_and_boundary():
    eng = BdcEngine()
    eng.publish_rate_board(board())
    t = eng.create_ticket(ticket(), actor="op-1", customer_weekly_fx_usd_minor=0)
    day = t.created_at.date().isoformat()
    report = cbn_bdc_daily_return(list(eng.tickets.values()), day)
    assert report["ticket_count"] == 1
    assert report["fx_sold_minor"] == 500_00
    assert report["prepared"] is True and report["submitted"] is False


def test_api_boundary_and_flow():
    from fastapi.testclient import TestClient
    from umojaflowos_remittance_bdc.service import create_app
    client = TestClient(create_app())
    assert "execution_authority" in client.get("/healthz").json()

    r = client.post("/v1/remittances", json={
        "remittance_id": "REM-API-1", "corridor": "GB_NG",
        "remitter_id": "R9", "kyc_subject_id": "KYC-9", "remitter_country": "GB", "kyc_tier": 3,
        "beneficiary_id": "B9", "beneficiary_name": "Chidi Eze", "beneficiary_country": "NG",
        "bank_code": "044", "account_reference": "tok_123",
        "purpose": "education", "send_amount_minor": 200_000, "send_currency": "GBP",
        "receive_currency": "NGN", "payout_channel": "bank_credit",
    })
    assert r.status_code == 201
    assert r.json()["advisory_only"] is True

    rb = client.post("/v1/bdc/rate-boards", json={
        "currency": "USD", "buy_rate_ngn": "1500.00", "sell_rate_ngn": "1503.00",
        "cbn_reference_ngn": "1500.00", "band_bps": 500, "actor": "op-1",
    })
    assert rb.status_code == 201

    tk = client.post("/v1/bdc/tickets", json={
        "ticket_id": "TKT-API-1", "bdc_operator_id": "BDC-LAG-01", "branch_id": "BR-IKEJA",
        "side": "sell_fx", "fx_currency": "USD", "fx_amount_minor": 100_00,
        "rate_ngn": "1503.00", "ngn_amount_minor": 150_300_00,
        "customer_subject_id": "CUST-9", "id_evidence_sha256": "e" * 64, "actor": "op-1",
    })
    assert tk.status_code == 201
    bad = client.post("/v1/bdc/tickets", json={
        "ticket_id": "TKT-API-2", "bdc_operator_id": "BDC-LAG-01", "branch_id": "BR-IKEJA",
        "side": "sell_fx", "fx_currency": "USD", "fx_amount_minor": 100_00,
        "rate_ngn": "1999.00", "ngn_amount_minor": 199_900_00,
        "customer_subject_id": "CUST-9", "id_evidence_sha256": "e" * 64, "actor": "op-1",
    })
    assert bad.status_code == 422  # off-board rate rejected
