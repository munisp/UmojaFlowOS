"""FastAPI surface for the remittance & BDC control-plane service.

Same boundary as the rest of the platform: every response states
``execution_authority: none`` — preparation and evidence only.
"""
from __future__ import annotations

from decimal import Decimal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .bdc import BdcEngine, cbn_bdc_daily_return
from .domain import (
    Beneficiary, BdcRateBoardEntry, BdcTicket, BdcTicketSide,
    Corridor, PolicyViolation, PurposeCode, RemittanceOrder, Remitter,
    PayoutChannel, utcnow,
)
from .remittance import RemittanceEngine, cbn_imto_daily_return


# Request models must live at module level: under
# ``from __future__ import annotations``, models defined inside a function
# cannot be resolved by FastAPI and the body is silently treated as a query
# parameter (422). Same fix as ml-intelligence inference service.
class RemittanceCreate(BaseModel):
    remittance_id: str
    corridor: Corridor
    remitter_id: str
    kyc_subject_id: str
    remitter_country: str
    kyc_tier: int = Field(ge=1, le=3)
    beneficiary_id: str
    beneficiary_name: str
    beneficiary_country: str
    bank_code: str | None = None
    account_reference: str | None = None
    mobile_wallet_id: str | None = None
    verified_evidence_sha256: str | None = None
    purpose: PurposeCode
    send_amount_minor: int = Field(gt=0)
    send_currency: str
    receive_currency: str
    payout_channel: PayoutChannel


class RateLockRequest(BaseModel):
    rate: str
    actor: str


class RateBoardRequest(BaseModel):
    currency: str
    buy_rate_ngn: str
    sell_rate_ngn: str
    cbn_reference_ngn: str
    band_bps: int = Field(ge=0, le=5000)
    actor: str


class TicketRequest(BaseModel):
    ticket_id: str
    bdc_operator_id: str
    branch_id: str
    side: BdcTicketSide
    fx_currency: str
    fx_amount_minor: int = Field(gt=0)
    rate_ngn: str
    ngn_amount_minor: int = Field(gt=0)
    customer_subject_id: str
    id_evidence_sha256: str = Field(min_length=64, max_length=64)
    actor: str
    customer_weekly_fx_usd_minor: int = 0


def create_app() -> FastAPI:
    app = FastAPI(title="UmojaFlowOS Remittance & BDC", version="1.0.0")
    remit = RemittanceEngine()
    bdc = BdcEngine()

    def boundary() -> dict:
        return {"execution_authority": "none — licensed partner executes; platform records evidence and preparation",
                "advisory_only": True}

    @app.get("/healthz")
    def healthz():
        return {"status": "ok", **boundary()}

    # ------------------------------------------------------------- remittance
    @app.post("/v1/remittances", status_code=201)
    def create_remittance(req: RemittanceCreate):
        order = RemittanceOrder(
            remittance_id=req.remittance_id, corridor=req.corridor,
            remitter=Remitter(req.remitter_id, req.kyc_subject_id, req.remitter_country, req.kyc_tier),
            beneficiary=Beneficiary(req.beneficiary_id, req.beneficiary_name, req.beneficiary_country,
                                    req.bank_code, req.account_reference, req.mobile_wallet_id,
                                    req.verified_evidence_sha256),
            purpose=req.purpose, send_amount_minor=req.send_amount_minor,
            send_currency=req.send_currency, receive_amount_minor=None,
            receive_currency=req.receive_currency, payout_channel=req.payout_channel,
        )
        try:
            remit.validate_order(order)
            remit.orders[order.remittance_id] = order
        except PolicyViolation as exc:
            raise HTTPException(422, str(exc))
        return {"remittance_id": order.remittance_id, "state": order.state.value, **boundary()}

    @app.post("/v1/remittances/{remittance_id}/rate-locks", status_code=201)
    def create_rate_lock(remittance_id: str, req: RateLockRequest):
        if remittance_id not in remit.orders:
            raise HTTPException(404, "remittance not found")
        try:
            return {**remit.create_rate_lock(remittance_id, Decimal(req.rate), req.actor), **boundary()}
        except PolicyViolation as exc:
            raise HTTPException(422, str(exc))

    @app.get("/v1/remittances/{remittance_id}")
    def get_remittance(remittance_id: str):
        order = remit.orders.get(remittance_id)
        if not order:
            raise HTTPException(404, "remittance not found")
        return {"remittance_id": order.remittance_id, "state": order.state.value,
                "history": order.history, **boundary()}

    @app.get("/v1/returns/imto-daily")
    def imto_daily(day: str):
        return {**cbn_imto_daily_return(list(remit.orders.values()), day), **boundary()}

    # -------------------------------------------------------------------- BDC
    @app.post("/v1/bdc/rate-boards", status_code=201)
    def publish_board(req: RateBoardRequest):
        entry = BdcRateBoardEntry(
            currency=req.currency, buy_rate_ngn=Decimal(req.buy_rate_ngn),
            sell_rate_ngn=Decimal(req.sell_rate_ngn), cbn_reference_ngn=Decimal(req.cbn_reference_ngn),
            band_bps=req.band_bps, effective_at=utcnow(), set_by=req.actor,
        )
        try:
            bdc.publish_rate_board(entry)
        except PolicyViolation as exc:
            raise HTTPException(422, str(exc))
        return {"currency": entry.currency, "published": True, **boundary()}

    @app.post("/v1/bdc/tickets", status_code=201)
    def create_ticket(req: TicketRequest):
        ticket = BdcTicket(
            ticket_id=req.ticket_id, bdc_operator_id=req.bdc_operator_id, branch_id=req.branch_id,
            side=req.side, fx_currency=req.fx_currency, fx_amount_minor=req.fx_amount_minor,
            rate_ngn=Decimal(req.rate_ngn), ngn_amount_minor=req.ngn_amount_minor,
            customer_subject_id=req.customer_subject_id, id_evidence_sha256=req.id_evidence_sha256,
        )
        try:
            bdc.create_ticket(ticket, req.actor, req.customer_weekly_fx_usd_minor)
        except PolicyViolation as exc:
            raise HTTPException(422, str(exc))
        return {"ticket_id": ticket.ticket_id, "state": ticket.state.value, **boundary()}

    @app.get("/v1/bdc/vault/{bdc_operator_id}/{branch_id}")
    def vault(bdc_operator_id: str, branch_id: str):
        positions = bdc.vault_position(bdc_operator_id, branch_id)
        return {"positions": [
            {"currency": p.currency, "balance_minor": p.balance_minor, "updated_at": p.updated_at.isoformat()}
            for p in positions
        ], "shortfall_alert": bdc.negative_vault_alert(bdc_operator_id, branch_id), **boundary()}

    @app.get("/v1/returns/bdc-daily")
    def bdc_daily(day: str):
        return {**cbn_bdc_daily_return(list(bdc.tickets.values()), day), **boundary()}

    return app
