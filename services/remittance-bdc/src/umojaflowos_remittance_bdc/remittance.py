"""Remittance engine: validation, caps, rate locks, AML signals, lifecycle.

Evidence-only. Every "approval" here means *approved for controlled payout
preparation* — the licensed IMTO partner executes actual payout and reports
finality evidence back.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal

from .domain import (
    BDC_CASH_TXN_REPORTING_THRESHOLD_NGN_MINOR,
    CASH_PICKUP_CAP_USD_CENTS,
    DAILY_SENDER_CAP_USD_CENTS,
    MONTHLY_BENEFICIARY_CAP_USD_CENTS,
    SINGLE_TXN_CAP_USD_CENTS,
    STRUCTURING_MIN_TXNS,
    STRUCTURING_WINDOW_HOURS,
    Beneficiary,
    Corridor,
    PolicyViolation,
    PurposeCode,
    RemittanceOrder,
    RemittanceState,
    Remitter,
    PayoutChannel,
    utcnow,
)

RATE_LOCK_TTL_SECONDS = 900  # 15 minutes, industry-standard retail FX lock


class RemittanceEngine:
    """In-memory reference store; production wiring persists via PostgreSQL
    migration 0064 (remittance_bdc schema) with the same invariants."""

    def __init__(self):
        self.orders: dict[str, RemittanceOrder] = {}
        self.rate_locks: dict[str, dict] = {}

    # ------------------------------------------------------------ validation
    def validate_order(self, order: RemittanceOrder) -> None:
        if order.send_amount_minor <= 0:
            raise PolicyViolation("send amount must be positive minor units")
        if order.send_currency == order.receive_currency and order.receive_amount_minor is None:
            raise PolicyViolation("same-currency remittance requires an explicit receive amount")
        if order.payout_channel == PayoutChannel.BANK_CREDIT and not (
            order.beneficiary.bank_code and order.beneficiary.account_reference
        ):
            raise PolicyViolation("bank-credit payout requires verified beneficiary bank details")
        if order.payout_channel == PayoutChannel.MOBILE_MONEY and not order.beneficiary.mobile_wallet_id:
            raise PolicyViolation("mobile-money payout requires a wallet identifier")
        if order.payout_channel == PayoutChannel.CASH_PICKUP and not order.beneficiary.verified_evidence_sha256:
            raise PolicyViolation("cash pickup requires beneficiary verification evidence (BVN/NIN-flavoured)")
        if not order.beneficiary.legal_name.strip():
            raise PolicyViolation("beneficiary legal name is required for Travel-Rule-flavoured evidence")

    def check_caps(
        self,
        order: RemittanceOrder,
        usd_equivalent_minor: int,
        sender_last_24h_usd_minor: int,
        beneficiary_last_30d_usd_minor: int,
    ) -> list[str]:
        """Returns review triggers (not auto-blocks) — humans decide on triggers."""
        triggers: list[str] = []
        if usd_equivalent_minor > SINGLE_TXN_CAP_USD_CENTS:
            raise PolicyViolation("single transaction exceeds the IMTO per-transaction cap")
        if order.payout_channel == PayoutChannel.CASH_PICKUP and usd_equivalent_minor > CASH_PICKUP_CAP_USD_CENTS:
            raise PolicyViolation("cash-pickup amount exceeds the cash-channel cap")
        if sender_last_24h_usd_minor + usd_equivalent_minor > DAILY_SENDER_CAP_USD_CENTS:
            triggers.append("sender rolling 24h cap exceeded")
        if beneficiary_last_30d_usd_minor + usd_equivalent_minor > MONTHLY_BENEFICIARY_CAP_USD_CENTS:
            triggers.append("beneficiary rolling 30d cap exceeded")
        return triggers

    # -------------------------------------------------------------- rate lock
    def create_rate_lock(self, remittance_id: str, rate: Decimal, actor: str) -> dict:
        if rate <= 0:
            raise PolicyViolation("rate must be positive")
        lock = {
            "rate_lock_id": f"RL-{remittance_id}",
            "remittance_id": remittance_id,
            "rate": str(rate),
            "created_by": actor,
            "expires_at": (utcnow() + timedelta(seconds=RATE_LOCK_TTL_SECONDS)).isoformat(),
        }
        self.rate_locks[lock["rate_lock_id"]] = lock
        return lock

    def consume_rate_lock(self, order: RemittanceOrder, rate_lock_id: str) -> Decimal:
        lock = self.rate_locks.get(rate_lock_id)
        if not lock or lock["remittance_id"] != order.remittance_id:
            raise PolicyViolation("rate lock does not belong to this remittance")
        if datetime.fromisoformat(lock["expires_at"]) < utcnow():
            raise PolicyViolation("rate lock expired — quote must be refreshed (stale-rate execution prevented)")
        order.rate_lock_id = rate_lock_id
        order.rate_lock_expires_at = datetime.fromisoformat(lock["expires_at"])
        return Decimal(lock["rate"])

    # ------------------------------------------------------------- AML signals
    @staticmethod
    def structuring_signal(amounts_usd_minor_last_24h: list[int]) -> str | None:
        """Repeated sub-cap sends inside a short window = classic remittance structuring."""
        if len(amounts_usd_minor_last_24h) >= STRUCTURING_MIN_TXNS:
            if all(a < SINGLE_TXN_CAP_USD_CENTS for a in amounts_usd_minor_last_24h) and (
                sum(amounts_usd_minor_last_24h) > SINGLE_TXN_CAP_USD_CENTS
            ):
                return "potential structuring: multiple sub-cap sends aggregate over the single-transaction cap"
        return None

    @staticmethod
    def smurfing_signal(distinct_senders: int, shared_beneficiary: bool) -> str | None:
        if shared_beneficiary and distinct_senders >= STRUCTURING_MIN_TXNS:
            return "potential smurfing: many distinct senders converging on one beneficiary"
        return None

    @staticmethod
    def cash_reporting_signal(ngn_amount_minor: int) -> str | None:
        if ngn_amount_minor >= BDC_CASH_TXN_REPORTING_THRESHOLD_NGN_MINOR:
            return "amount meets the ₦5m cash transaction reporting threshold — returns evidence required"
        return None

    # -------------------------------------------------------------- lifecycle
    def submit(self, order: RemittanceOrder, actor: str, screening_case_id: str) -> RemittanceOrder:
        self.validate_order(order)
        if order.state != RemittanceState.DRAFT:
            raise PolicyViolation("only a draft remittance can be submitted")
        order.screening_case_id = screening_case_id
        order.transition(RemittanceState.SCREENING, actor, "submitted for sanctions/fraud screening")
        self.orders[order.remittance_id] = order
        return order

    def screening_cleared(self, order: RemittanceOrder, actor: str, review_triggers: list[str]) -> None:
        if review_triggers:
            order.review_reason = "; ".join(review_triggers)
            order.transition(RemittanceState.REVIEW_REQUIRED, actor, order.review_reason)
        else:
            order.transition(RemittanceState.RATE_LOCKED, actor, "screening cleared, rate lock applied")

    def human_review_decision(self, order: RemittanceOrder, actor: str, approved: bool, rationale: str) -> None:
        if not rationale.strip():
            raise PolicyViolation("human review requires a recorded rationale")
        if approved:
            order.transition(RemittanceState.RATE_LOCKED, actor, f"reviewer cleared: {rationale}")
        else:
            order.transition(RemittanceState.CANCELLED, actor, f"reviewer declined: {rationale}")

    def approve_for_payout_preparation(self, order: RemittanceOrder, actor: str, rate_lock_id: str) -> None:
        self.consume_rate_lock(order, rate_lock_id)
        order.transition(RemittanceState.APPROVED_FOR_PAYOUT_PREPARATION, actor,
                         "approved for controlled payout preparation — partner executes, platform does not")

    def record_payout_evidence(self, order: RemittanceOrder, actor: str, evidence_sha256: str, reference: str) -> dict:
        if len(evidence_sha256) != 64:
            raise PolicyViolation("payout evidence must be a sha256 digest")
        order.transition(RemittanceState.PAYOUT_EVIDENCE_RECORDED, actor,
                         f"partner payout evidence recorded (ref {reference})")
        return {"evidence_sha256": evidence_sha256, "reference": reference,
                "partner_execution": True, "platform_execution": False}

    def record_partner_finality(self, order: RemittanceOrder, actor: str, partner_reference: str) -> None:
        order.transition(RemittanceState.COMPLETED_BY_PARTNER, actor,
                         f"licensed partner reported final settlement (ref {partner_reference})")

    def refund(self, order: RemittanceOrder, actor: str, reason: str) -> None:
        if not reason.strip():
            raise PolicyViolation("refund requires a reason for the complaints/evidence trail")
        order.transition(RemittanceState.REFUNDED, actor, reason)


def cbn_imto_daily_return(orders: list[RemittanceOrder], day: str) -> dict:
    """Aggregate the IMTO daily-returns evidence pack (prepared, never submitted)."""
    rows = [o for o in orders if o.created_at.date().isoformat() == day]
    by_corridor: dict[str, dict] = {}
    for o in rows:
        c = by_corridor.setdefault(o.corridor.value, {"count": 0, "send_minor": 0})
        c["count"] += 1
        c["send_minor"] += o.send_amount_minor
    return {
        "return_type": "imto_daily_operations",
        "day": day,
        "corridors": by_corridor,
        "total_transactions": len(rows),
        "prepared": True,
        "submitted": False,
        "submission_boundary": "licensed IMTO submits via its authorised channel; platform evidence only",
    }
