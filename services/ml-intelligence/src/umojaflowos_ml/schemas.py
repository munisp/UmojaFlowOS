"""Shared contracts for the ML intelligence stack.

These schemas are the stable interface between data generation, the Lakehouse,
training loops, the registry, and CPU inference. Everything is plain
dataclasses so the training pipeline has no service-runtime dependencies.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any
import hashlib
import json


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def sha256_of(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


@dataclass(frozen=True)
class Transaction:
    """One NGN-denominated account-to-account or account-to-merchant transfer."""
    txn_id: str
    ts: str                      # ISO-8601 UTC
    src_account: str
    dst_account: str             # merchant ids prefixed with MCH_
    amount_ngn: float
    channel: str                 # ussd | nip_instant | pos | web | atm | agent
    txn_type: str                # p2p | bill | airtime | pos_purchase | cash_out | salary | transfer_out
    src_bank: str
    dst_bank: str
    device_id: str
    ip_country: str
    is_cross_border: bool
    label_fraud: int = 0         # 1 if the generator tagged it as a fraud typology instance
    fraud_typology: str = "legit"


@dataclass(frozen=True)
class AccountProfile:
    account_id: str
    bank: str
    state: str                   # Nigerian state of KYC address
    age_band: str
    kyc_tier: int                # 1..3 (CBN tiered KYC)
    monthly_income_ngn: float
    opened_days: int
    is_mule: int = 0
    credit_default: int = 0      # label: defaulted on a credit obligation in the window


@dataclass
class TrainedArtifact:
    """Metadata stored next to every .pt weight file."""
    model_name: str
    version: str
    trained_at: str
    weights_sha256: str
    metrics: dict[str, float]
    feature_config: dict[str, Any]
    training_window: str
    data_provenance: str
    n_train: int
    n_val: int
    epochs_run: int
    seed: int
    advisory_only: bool = True

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, sort_keys=True)

    @staticmethod
    def from_json(text: str) -> "TrainedArtifact":
        return TrainedArtifact(**json.loads(text))


@dataclass
class DriftReport:
    feature: str
    psi: float
    ks_statistic: float
    drifted: bool


@dataclass
class MonitoringAlert:
    alert: str
    severity: str                # info | warning | critical
    detail: dict[str, Any] = field(default_factory=dict)
    raised_at: str = field(default_factory=lambda: utcnow().isoformat())
