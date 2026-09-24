"""The generator must produce realistic, labelled, reproducible data."""
from __future__ import annotations

import pandas as pd

from umojaflowos_ml.synthetic_nigeria import FRAUD_TYPOLOGIES, NigerianPaymentsGenerator


def test_generator_is_deterministic():
    g1 = NigerianPaymentsGenerator(seed=99)
    g2 = NigerianPaymentsGenerator(seed=99)
    a1 = g1.generate_accounts(100)
    a2 = g2.generate_accounts(100)
    assert [a.account_id for a in a1] == [a.account_id for a in a2]
    t1 = g1.generate_transactions(a1, 500)
    t2 = g2.generate_transactions(a2, 500)
    pd.testing.assert_frame_equal(t1, t2)


def test_all_fraud_typologies_injected_and_labelled(small_corpus):
    txns, _ = small_corpus
    fraud = txns[txns["label_fraud"] == 1]
    assert len(fraud) > 0
    assert set(fraud["fraud_typology"].unique()) == set(FRAUD_TYPOLOGIES)
    assert (txns[txns["label_fraud"] == 0]["fraud_typology"] == "legit").all()


def test_realistic_nigerian_distributions(small_corpus):
    txns, accounts = small_corpus
    # amounts positive, NGN-scale, capped by tier-3 daily limit
    assert txns["amount_ngn"].min() > 0
    assert txns["amount_ngn"].max() < 30_000_000
    # NIP dominates, USSD significant — matches NIBSS retail pattern
    share = txns["channel"].value_counts(normalize=True)
    assert share["nip_instant"] > 0.3
    assert share["ussd"] > 0.1
    # night activity exists but is a small fraction
    night = pd.to_datetime(txns["ts"]).dt.hour.isin([0, 1, 2, 3, 4]).mean()
    assert night < 0.08
    # income distribution is realistic for Nigeria (median well under N1m/month)
    assert accounts["monthly_income_ngn"].median() < 1_000_000
    # KYC tiers present
    assert set(accounts["kyc_tier"].unique()) == {1, 2, 3}


def test_account_takeover_signature(small_corpus):
    txns, _ = small_corpus
    ato = txns[txns["fraud_typology"] == "account_takeover"]
    assert len(ato) > 0
    hours = pd.to_datetime(ato["ts"]).dt.hour
    assert hours.isin([1, 2, 3, 4]).all()          # night-time
    assert (ato["ip_country"] != "NG").all()       # foreign IP
    assert (ato["device_id"].str.contains("UNKNOWN")).all()  # new device
