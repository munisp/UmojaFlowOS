from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from umojaflowos_ml.synthetic_nigeria import NigerianPaymentsGenerator  # noqa: E402


@pytest.fixture(scope="session")
def small_corpus():
    gen = NigerianPaymentsGenerator(seed=7)
    accounts_raw = gen.generate_accounts(600)
    txns = gen.generate_transactions(accounts_raw, 12_000, fraud_rate=0.03)
    import pandas as pd
    accounts = pd.DataFrame([a.__dict__ for a in gen.assign_credit_labels(accounts_raw, txns)])
    return txns, accounts
