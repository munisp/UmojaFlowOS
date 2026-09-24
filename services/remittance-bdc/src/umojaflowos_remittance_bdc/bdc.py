"""Bureau de Change (BDC) engine: rate boards, FX tickets, vault position.

Evidence-only. Tickets are controlled preparation records; the authorised
dealer BDC settles with its own cash/FX and files its own CBN returns.
"""
from __future__ import annotations

from datetime import timedelta
from decimal import Decimal

from .domain import (
    BDC_CASH_TXN_REPORTING_THRESHOLD_NGN_MINOR,
    BDC_MAX_SPREAD_BPS,
    BDC_SINGLE_CUSTOMER_WEEKLY_CAP_USD_CENTS,
    BdcRateBoardEntry,
    BdcTicket,
    BdcTicketSide,
    BdcTicketState,
    PolicyViolation,
    VaultPosition,
    utcnow,
)

RATE_BOARD_STALE_MINUTES = 240  # rate boards older than 4h cannot clear tickets


class BdcEngine:
    def __init__(self):
        self.tickets: dict[str, BdcTicket] = {}
        self.rate_boards: dict[str, BdcRateBoardEntry] = {}   # key: currency
        self.vault: dict[tuple[str, str, str], VaultPosition] = {}

    # -------------------------------------------------------------- rate board
    def publish_rate_board(self, entry: BdcRateBoardEntry) -> BdcRateBoardEntry:
        if entry.buy_rate_ngn <= 0 or entry.sell_rate_ngn <= 0:
            raise PolicyViolation("rate board rates must be positive")
        if entry.sell_rate_ngn <= entry.buy_rate_ngn:
            raise PolicyViolation("sell rate must exceed buy rate")
        spread_bps = int((entry.sell_rate_ngn - entry.buy_rate_ngn) / entry.buy_rate_ngn * 10_000)
        if spread_bps > BDC_MAX_SPREAD_BPS:
            raise PolicyViolation(f"spread {spread_bps}bps exceeds the {BDC_MAX_SPREAD_BPS}bps governance ceiling")
        deviation_bps = abs(int((entry.sell_rate_ngn - entry.cbn_reference_ngn) / entry.cbn_reference_ngn * 10_000))
        if deviation_bps > entry.band_bps:
            raise PolicyViolation(
                f"sell rate deviates {deviation_bps}bps from the CBN reference, beyond the {entry.band_bps}bps band"
            )
        self.rate_boards[entry.currency] = entry
        return entry

    def _current_board(self, currency: str) -> BdcRateBoardEntry:
        board = self.rate_boards.get(currency)
        if board is None:
            raise PolicyViolation(f"no rate board published for {currency}")
        if utcnow() - board.effective_at > timedelta(minutes=RATE_BOARD_STALE_MINUTES):
            raise PolicyViolation(f"{currency} rate board is stale (> {RATE_BOARD_STALE_MINUTES}m) — refresh required")
        return board

    # ----------------------------------------------------------------- tickets
    def create_ticket(
        self,
        ticket: BdcTicket,
        actor: str,
        customer_weekly_fx_usd_minor: int,
    ) -> BdcTicket:
        if ticket.fx_amount_minor <= 0 or ticket.ngn_amount_minor <= 0:
            raise PolicyViolation("ticket amounts must be positive minor units")
        if len(ticket.id_evidence_sha256) != 64:
            raise PolicyViolation("customer ID evidence (sha256) is required for every BDC ticket")
        board = self._current_board(ticket.fx_currency)
        expected_rate = board.sell_rate_ngn if ticket.side == BdcTicketSide.SELL_FX else board.buy_rate_ngn
        # ticket rate must be at or better than board for the customer, never worse
        if ticket.side == BdcTicketSide.SELL_FX and ticket.rate_ngn > board.sell_rate_ngn:
            raise PolicyViolation("sell ticket rate exceeds the published board — off-board execution prevented")
        if ticket.side == BdcTicketSide.BUY_FX and ticket.rate_ngn < board.buy_rate_ngn:
            raise PolicyViolation("buy ticket rate undercuts the published board — off-board execution prevented")
        usd_equiv = ticket.fx_amount_minor if ticket.fx_currency == "USD" else ticket.fx_amount_minor  # reference
        if customer_weekly_fx_usd_minor + usd_equiv > BDC_SINGLE_CUSTOMER_WEEKLY_CAP_USD_CENTS:
            raise PolicyViolation("customer weekly retail FX cap exceeded")
        ticket.transition(BdcTicketState.RATE_BOARD_CHECKED, actor, "rate board and caps validated")
        self.tickets[ticket.ticket_id] = ticket
        return ticket

    def flag_counterfeit(self, ticket: BdcTicket, actor: str, note: str) -> None:
        if not note.strip():
            raise PolicyViolation("counterfeit flag requires an evidence note")
        ticket.counterfeit_flag = True
        ticket.transition(BdcTicketState.REVIEW_REQUIRED, actor, f"counterfeit note evidence: {note}")

    def approve_for_settlement_preparation(self, ticket: BdcTicket, actor: str) -> None:
        ticket.transition(BdcTicketState.APPROVED_FOR_SETTLEMENT_PREPARATION, actor,
                          "approved for controlled settlement preparation — BDC settles, platform does not")

    def record_settlement_evidence(self, ticket: BdcTicket, actor: str, evidence_sha256: str) -> dict:
        if len(evidence_sha256) != 64:
            raise PolicyViolation("settlement evidence must be a sha256 digest")
        ticket.transition(BdcTicketState.SETTLEMENT_EVIDENCE_RECORDED, actor, "settlement evidence recorded")
        self._apply_vault(ticket)
        return {"evidence_sha256": evidence_sha256, "platform_settlement": False}

    # ------------------------------------------------------------------- vault
    def _apply_vault(self, ticket: BdcTicket) -> None:
        fx_key = (ticket.bdc_operator_id, ticket.branch_id, ticket.fx_currency)
        ngn_key = (ticket.bdc_operator_id, ticket.branch_id, "NGN")
        fx = self.vault.setdefault(fx_key, VaultPosition(ticket.bdc_operator_id, ticket.branch_id, ticket.fx_currency, 0))
        ngn = self.vault.setdefault(ngn_key, VaultPosition(ticket.bdc_operator_id, ticket.branch_id, "NGN", 0))
        if ticket.side == BdcTicketSide.SELL_FX:     # BDC sells FX: FX down, NGN up
            fx.balance_minor -= ticket.fx_amount_minor
            ngn.balance_minor += ticket.ngn_amount_minor
        else:                                        # BDC buys FX: FX up, NGN down
            fx.balance_minor += ticket.fx_amount_minor
            ngn.balance_minor -= ticket.ngn_amount_minor
        fx.updated_at = utcnow()
        ngn.updated_at = utcnow()

    def vault_position(self, bdc_operator_id: str, branch_id: str) -> list[VaultPosition]:
        return [p for (op, br, _), p in self.vault.items() if op == bdc_operator_id and br == branch_id]

    def negative_vault_alert(self, bdc_operator_id: str, branch_id: str) -> str | None:
        for p in self.vault_position(bdc_operator_id, branch_id):
            if p.balance_minor < 0:
                return f"vault shortfall: {p.currency} balance {p.balance_minor} minor at {branch_id} — funding evidence required"
        return None


def cbn_bdc_daily_return(tickets: list[BdcTicket], day: str) -> dict:
    """Aggregate BDC daily returns evidence (prepared, never submitted)."""
    rows = [t for t in tickets if t.created_at.date().isoformat() == day]
    sold = sum(t.fx_amount_minor for t in rows if t.side == BdcTicketSide.SELL_FX)
    bought = sum(t.fx_amount_minor for t in rows if t.side == BdcTicketSide.BUY_FX)
    over_threshold = [
        t.ticket_id for t in rows if t.ngn_amount_minor >= BDC_CASH_TXN_REPORTING_THRESHOLD_NGN_MINOR
    ]
    return {
        "return_type": "bdc_daily_operations",
        "day": day,
        "ticket_count": len(rows),
        "fx_sold_minor": sold,
        "fx_bought_minor": bought,
        "cash_reporting_threshold_tickets": over_threshold,
        "counterfeit_flags": sum(1 for t in rows if t.counterfeit_flag),
        "prepared": True,
        "submitted": False,
        "submission_boundary": "licensed BDC files via its authorised channel; platform evidence only",
    }
