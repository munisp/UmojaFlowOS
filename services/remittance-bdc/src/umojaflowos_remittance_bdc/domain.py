"""Remittance and BDC domain model with CBN-flavoured policy rules.

All amounts are integer minor units (kobo for NGN, cents for USD) — never
floats — consistent with the platform's exact-money invariant.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone, timedelta
from enum import Enum
from decimal import Decimal
import hashlib
import json


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ------------------------------------------------------------------ remittance
class Corridor(str, Enum):
    US_NG = "US_NG"   # diaspora inbound USD -> NGN
    GB_NG = "GB_NG"
    EU_NG = "EU_NG"
    CA_NG = "CA_NG"
    NG_KE = "NG_KE"   # intra-Africa
    NG_ZA = "NG_ZA"
    KE_NG = "KE_NG"


class PayoutChannel(str, Enum):
    BANK_CREDIT = "bank_credit"          # NIP credit to beneficiary account
    CASH_PICKUP = "cash_pickup"          # agent/branch cash payout
    MOBILE_MONEY = "mobile_money"        # wallet credit
    USD_DOMICILIARY = "usd_domiciliary"  # dom account credit (CBN 2024+ rules)


class PurposeCode(str, Enum):
    """CBN-flavoured remittance purpose codes."""
    FAMILY_SUPPORT = "family_support"
    MEDICAL = "medical"
    EDUCATION = "education"
    DIASPORA_INVESTMENT = "diaspora_investment"
    GIFT = "gift"
    SALARY_REPATRIATION = "salary_repatriation"
    NGO_FUNDING = "ngo_funding"


class RemittanceState(str, Enum):
    DRAFT = "draft"
    SCREENING = "screening"
    RATE_LOCKED = "rate_locked"
    REVIEW_REQUIRED = "review_required"     # compliance hold for human decision
    APPROVED_FOR_PAYOUT_PREPARATION = "approved_for_payout_preparation"
    PAYOUT_EVIDENCE_RECORDED = "payout_evidence_recorded"
    COMPLETED_BY_PARTNER = "completed_by_partner"   # partner-reported finality
    REFUNDED = "refunded"
    CANCELLED = "cancelled"


# CBN-style per-transaction and rolling caps (minor units). USD cent reference.
SINGLE_TXN_CAP_USD_CENTS = 10_000_00                # $10,000 per transaction (1,000,000 cents)
DAILY_SENDER_CAP_USD_CENTS = 25_000_00              # $25,000 rolling 24h per sender
MONTHLY_BENEFICIARY_CAP_USD_CENTS = 100_000_00      # $100,000 rolling 30d per beneficiary
CASH_PICKUP_CAP_USD_CENTS = 2_000_00                # cash pickup tighter than bank credit
STRUCTURING_WINDOW_HOURS = 24
STRUCTURING_MIN_TXNS = 3


@dataclass(frozen=True)
class Remitter:
    remitter_id: str
    kyc_subject_id: str            # links to platform KYC evidence subject
    country: str
    kyc_tier: int


@dataclass(frozen=True)
class Beneficiary:
    beneficiary_id: str
    legal_name: str
    country: str
    bank_code: str | None
    account_reference: str | None  # tokenized — never raw PAN/NUBIN at rest
    mobile_wallet_id: str | None
    verified_evidence_sha256: str | None


@dataclass
class RemittanceOrder:
    remittance_id: str
    corridor: Corridor
    remitter: Remitter
    beneficiary: Beneficiary
    purpose: PurposeCode
    send_amount_minor: int
    send_currency: str
    receive_amount_minor: int | None
    receive_currency: str
    payout_channel: PayoutChannel
    state: RemittanceState = RemittanceState.DRAFT
    rate_lock_id: str | None = None
    rate_lock_expires_at: datetime | None = None
    screening_case_id: str | None = None
    review_reason: str | None = None
    created_at: datetime = field(default_factory=utcnow)
    history: list[dict] = field(default_factory=list)

    def transition(self, to: RemittanceState, actor: str, reason: str) -> None:
        allowed = REMITTANCE_TRANSITIONS.get(self.state, set())
        if to not in allowed:
            raise InvalidTransition(f"{self.state.value} -> {to.value} is not a permitted remittance transition")
        self.history.append({
            "from": self.state.value, "to": to.value, "actor": actor,
            "reason": reason, "at": utcnow().isoformat(),
        })
        self.state = to


REMITTANCE_TRANSITIONS: dict[RemittanceState, set[RemittanceState]] = {
    RemittanceState.DRAFT: {RemittanceState.SCREENING, RemittanceState.CANCELLED},
    RemittanceState.SCREENING: {RemittanceState.RATE_LOCKED, RemittanceState.REVIEW_REQUIRED, RemittanceState.CANCELLED},
    RemittanceState.RATE_LOCKED: {RemittanceState.APPROVED_FOR_PAYOUT_PREPARATION, RemittanceState.REVIEW_REQUIRED, RemittanceState.CANCELLED},
    RemittanceState.REVIEW_REQUIRED: {RemittanceState.RATE_LOCKED, RemittanceState.CANCELLED, RemittanceState.REFUNDED},
    RemittanceState.APPROVED_FOR_PAYOUT_PREPARATION: {RemittanceState.PAYOUT_EVIDENCE_RECORDED, RemittanceState.REFUNDED},
    RemittanceState.PAYOUT_EVIDENCE_RECORDED: {RemittanceState.COMPLETED_BY_PARTNER, RemittanceState.REFUNDED},
    RemittanceState.COMPLETED_BY_PARTNER: {RemittanceState.REFUNDED},
    RemittanceState.REFUNDED: set(),
    RemittanceState.CANCELLED: set(),
}


class InvalidTransition(ValueError):
    pass


class PolicyViolation(ValueError):
    pass


# ------------------------------------------------------------------------ BDC
class BdcTicketSide(str, Enum):
    SELL_FX = "sell_fx"   # BDC sells FX, customer pays NGN
    BUY_FX = "buy_fx"     # BDC buys FX, customer receives NGN


class BdcTicketState(str, Enum):
    DRAFT = "draft"
    RATE_BOARD_CHECKED = "rate_board_checked"
    REVIEW_REQUIRED = "review_required"
    APPROVED_FOR_SETTLEMENT_PREPARATION = "approved_for_settlement_preparation"
    SETTLEMENT_EVIDENCE_RECORDED = "settlement_evidence_recorded"
    VOIDED = "voided"


@dataclass
class BdcRateBoardEntry:
    currency: str                 # USD | GBP | EUR | CFA ...
    buy_rate_ngn: Decimal         # BDC buys 1 unit FX for this NGN
    sell_rate_ngn: Decimal
    cbn_reference_ngn: Decimal
    band_bps: int                 # permitted deviation from reference, basis points
    effective_at: datetime
    set_by: str


@dataclass
class BdcTicket:
    ticket_id: str
    bdc_operator_id: str
    branch_id: str
    side: BdcTicketSide
    fx_currency: str
    fx_amount_minor: int
    rate_ngn: Decimal
    ngn_amount_minor: int
    customer_subject_id: str
    id_evidence_sha256: str
    state: BdcTicketState = BdcTicketState.DRAFT
    counterfeit_flag: bool = False
    created_at: datetime = field(default_factory=utcnow)
    history: list[dict] = field(default_factory=list)

    def transition(self, to: BdcTicketState, actor: str, reason: str) -> None:
        allowed = BDC_TRANSITIONS.get(self.state, set())
        if to not in allowed:
            raise InvalidTransition(f"{self.state.value} -> {to.value} is not a permitted BDC ticket transition")
        self.history.append({"from": self.state.value, "to": to.value, "actor": actor,
                             "reason": reason, "at": utcnow().isoformat()})
        self.state = to


BDC_TRANSITIONS: dict[BdcTicketState, set[BdcTicketState]] = {
    BdcTicketState.DRAFT: {BdcTicketState.RATE_BOARD_CHECKED, BdcTicketState.VOIDED},
    BdcTicketState.RATE_BOARD_CHECKED: {BdcTicketState.APPROVED_FOR_SETTLEMENT_PREPARATION, BdcTicketState.REVIEW_REQUIRED, BdcTicketState.VOIDED},
    BdcTicketState.REVIEW_REQUIRED: {BdcTicketState.RATE_BOARD_CHECKED, BdcTicketState.VOIDED},
    BdcTicketState.APPROVED_FOR_SETTLEMENT_PREPARATION: {BdcTicketState.SETTLEMENT_EVIDENCE_RECORDED, BdcTicketState.VOIDED},
    BdcTicketState.SETTLEMENT_EVIDENCE_RECORDED: set(),
    BdcTicketState.VOIDED: set(),
}

# CBN-flavoured BDC controls (minor units; USD cent reference)
BDC_SINGLE_CUSTOMER_WEEKLY_CAP_USD_CENTS = 5_000_00   # $5,000 retail FX per customer per week
BDC_CASH_TXN_REPORTING_THRESHOLD_NGN_MINOR = 5_000_000_00   # ₦5m cash reporting threshold
BDC_MAX_SPREAD_BPS = 600                                     # governance ceiling on buy/sell spread


@dataclass
class VaultPosition:
    bdc_operator_id: str
    branch_id: str
    currency: str
    balance_minor: int
    updated_at: datetime = field(default_factory=utcnow)


def stable_hash(payload: dict) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
