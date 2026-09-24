"""Feature engineering: turn raw transactions into model-ready tensors.

Every feature is documented in FEATURE_NAMES; the same builder is used by
training and by CPU inference so there is no train/serve skew.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

NUMERIC_FEATURES = [
    "log_amount",
    "hour_sin", "hour_cos", "dow",
    "is_night", "is_weekend", "is_salary_window",
    "is_cross_border", "foreign_ip",
    "src_txn_count_30d", "src_avg_amount_30d", "src_std_amount_30d",
    "amount_vs_avg", "src_night_ratio_30d", "src_unique_counterparties",
    "src_unique_devices", "device_switch", "src_burst_max_1h",
    "round_amount", "under_threshold_5m", "kyc_tier",
    "dst_is_merchant", "dst_in_degree", "dst_out_degree",
]
CATEGORICAL_FEATURES = ["channel", "txn_type", "src_bank", "ip_country"]

VOCAB: dict[str, list[str]] = {
    "channel": ["nip_instant", "ussd", "pos", "web", "atm", "agent"],
    "txn_type": ["p2p", "bill", "airtime", "pos_purchase", "cash_out", "salary", "transfer_out"],
    "src_bank": ["AccessBank", "GTBank", "Zenith", "UBA", "FirstBank", "Kuda",
                 "OPay", "PalmPay", "Moniepoint", "Sterling", "Fidelity", "UnionBank", "OTHER"],
    "ip_country": ["NG", "GH", "KE", "GB", "US", "RU", "AE", "OTHER"],
}

REPORTING_THRESHOLD_NGN = 5_000_000.0


def _velocity_features(txns: pd.DataFrame) -> pd.DataFrame:
    """Per-account rolling behavioural stats (computed over the training window)."""
    t = txns.copy()
    t["dt"] = pd.to_datetime(t["ts"], utc=True)
    src_stats = t.groupby("src_account").agg(
        src_txn_count_30d=("txn_id", "count"),
        src_avg_amount_30d=("amount_ngn", "mean"),
        src_std_amount_30d=("amount_ngn", "std"),
        src_unique_counterparties=("dst_account", "nunique"),
        src_unique_devices=("device_id", "nunique"),
    ).reset_index()
    src_stats["src_std_amount_30d"] = src_stats["src_std_amount_30d"].fillna(0.0)

    t["hour"] = t["dt"].dt.hour
    night = t.assign(night=t["hour"].isin([0, 1, 2, 3, 4]).astype(int))
    night_ratio = night.groupby("src_account")["night"].mean().rename("src_night_ratio_30d").reset_index()

    # burst: max txns in any 1h window per account (approximate via hourly bins)
    t["hour_bin"] = t["dt"].dt.floor("h")
    burst = (
        t.groupby(["src_account", "hour_bin"]).size().groupby("src_account").max()
        .rename("src_burst_max_1h").reset_index()
    )

    # modal device per account
    modal_device = (
        t.groupby(["src_account", "device_id"]).size().reset_index(name="n")
        .sort_values("n", ascending=False).drop_duplicates("src_account")
        [["src_account", "device_id"]].rename(columns={"device_id": "modal_device"})
    )

    out_deg = t.groupby("src_account").size().rename("out_deg")
    in_deg = t[t["dst_account"].str.startswith("NGACC")].groupby("dst_account").size().rename("in_deg")

    t = t.merge(src_stats, on="src_account", how="left")
    t = t.merge(night_ratio, on="src_account", how="left")
    t = t.merge(burst, on="src_account", how="left")
    t = t.merge(modal_device, on="src_account", how="left")
    t["dst_in_degree"] = t["dst_account"].map(in_deg).fillna(0.0)
    t["dst_out_degree"] = t["dst_account"].map(out_deg).fillna(0.0)
    return t


def build_feature_frame(txns: pd.DataFrame, kyc_by_account: dict[str, int] | None = None) -> pd.DataFrame:
    """Return a frame with NUMERIC_FEATURES + CATEGORICAL_FEATURES + label columns."""
    t = _velocity_features(txns)
    t["dt"] = pd.to_datetime(t["ts"], utc=True)
    hour = t["dt"].dt.hour + t["dt"].dt.minute / 60.0
    t["log_amount"] = np.log1p(t["amount_ngn"].astype(float))
    t["hour_sin"] = np.sin(2 * np.pi * hour / 24.0)
    t["hour_cos"] = np.cos(2 * np.pi * hour / 24.0)
    t["dow"] = t["dt"].dt.dayofweek.astype(float) / 6.0
    t["is_night"] = t["dt"].dt.hour.isin([0, 1, 2, 3, 4]).astype(float)
    t["is_weekend"] = (t["dt"].dt.dayofweek >= 5).astype(float)
    day = t["dt"].dt.day
    t["is_salary_window"] = ((day >= 25) | (day <= 2)).astype(float)
    t["is_cross_border"] = t["is_cross_border"].astype(float)
    t["foreign_ip"] = (t["ip_country"] != "NG").astype(float)
    t["amount_vs_avg"] = t["amount_ngn"] / t["src_avg_amount_30d"].clip(lower=1.0)
    t["amount_vs_avg"] = np.log1p(t["amount_vs_avg"].clip(upper=1e4))
    t["device_switch"] = (t["device_id"] != t["modal_device"]).astype(float)
    t["round_amount"] = (t["amount_ngn"] % 500 == 0).astype(float)
    t["under_threshold_5m"] = (
        (t["amount_ngn"] >= 0.9 * REPORTING_THRESHOLD_NGN) & (t["amount_ngn"] < REPORTING_THRESHOLD_NGN)
    ).astype(float)
    t["dst_is_merchant"] = (~t["dst_account"].str.startswith("NGACC")).astype(float)
    if kyc_by_account is not None:
        t["kyc_tier"] = t["src_account"].map(kyc_by_account).fillna(2).astype(float)
    else:
        t["kyc_tier"] = 2.0
    for col in NUMERIC_FEATURES:
        t[col] = t[col].fillna(0.0).astype(np.float32)
    for col in CATEGORICAL_FEATURES:
        if col == "src_bank":
            t[col] = t[col].where(t[col].isin(VOCAB[col]), "OTHER")
        elif col == "ip_country":
            t[col] = t[col].where(t[col].isin(VOCAB[col]), "OTHER")
        t[col] = t[col].astype(str)
    return t


def encode_categoricals(frame: pd.DataFrame) -> dict[str, np.ndarray]:
    return {
        col: frame[col].map({v: i for i, v in enumerate(VOCAB[col])}).fillna(0).astype(np.int64).to_numpy()
        for col in CATEGORICAL_FEATURES
    }


def credit_feature_frame(txns: pd.DataFrame, accounts: pd.DataFrame) -> pd.DataFrame:
    """Account-level credit features joined onto the account table."""
    t = txns.copy()
    t["dt"] = pd.to_datetime(t["ts"], utc=True)
    g = t.groupby("src_account")
    feats = pd.DataFrame({
        "account_id": accounts["account_id"],
        "log_income": np.log1p(accounts["monthly_income_ngn"].astype(float)),
        "kyc_tier": accounts["kyc_tier"].astype(float),
        "log_opened_days": np.log1p(accounts["opened_days"].astype(float)),
        "age_band_code": accounts["age_band"].map({b: i for i, b in enumerate(["18-24", "25-34", "35-44", "45-54", "55+"])}).astype(float),
    })
    agg = g.agg(
        txn_count=("txn_id", "count"),
        total_outflow=("amount_ngn", "sum"),
        avg_amount=("amount_ngn", "mean"),
        unique_counterparties=("dst_account", "nunique"),
    ).reset_index().rename(columns={"src_account": "account_id"})
    gambling = t[t["dst_account"].str.contains("BET9JA|SPORTYBET|1XBET|NAIRABET", regex=True)]
    gambling_c = gambling.groupby("src_account").size().rename("gambling_txns").reset_index().rename(columns={"src_account": "account_id"})
    loans = t[t["dst_account"].str.contains("CARBON|FAIRMONEY|BRANCH|PALMCREDIT|RENWAVE", regex=True)]
    loan_c = loans.groupby("src_account").size().rename("loan_app_txns").reset_index().rename(columns={"src_account": "account_id"})
    night = t.assign(n=t["dt"].dt.hour.isin([0, 1, 2, 3, 4]).astype(int)).groupby("src_account")["n"].mean().rename("night_ratio").reset_index().rename(columns={"src_account": "account_id"})

    feats = feats.merge(agg, on="account_id", how="left")
    feats = feats.merge(gambling_c, on="account_id", how="left")
    feats = feats.merge(loan_c, on="account_id", how="left")
    feats = feats.merge(night, on="account_id", how="left")
    feats = feats.fillna(0.0)
    feats["spend_ratio"] = np.log1p(feats["total_outflow"] / np.expm1(feats["log_income"]).clip(lower=1.0))
    feats["log_txn_count"] = np.log1p(feats["txn_count"])
    feats["log_total_outflow"] = np.log1p(feats["total_outflow"])
    feats["log_avg_amount"] = np.log1p(feats["avg_amount"])
    return feats


CREDIT_FEATURES = [
    "log_income", "kyc_tier", "log_opened_days", "age_band_code",
    "log_txn_count", "log_total_outflow", "log_avg_amount",
    "unique_counterparties", "gambling_txns", "loan_app_txns",
    "night_ratio", "spend_ratio",
]
