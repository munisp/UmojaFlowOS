"""Synthetic Nigerian retail-payment data generator.

The platform previously generated training data in-memory with no realistic
distributions. This generator encodes observed structure of the Nigerian
payment landscape so the trained weights carry real signal:

* NIBSS-style instant payments (NIP) dominate volume; USSD is heavy for
  low-income / feature-phone segments; POS/agent (Moniepoint/OPay/PalmPay)
  cash-out is a distinct behavioural cluster.
* NGN amounts are log-normal with kobo-level rounding, strong round-amount
  preference for P2P, and salary-cycle seasonality (25th-2nd of month).
* Night-time, SIM-swap-flavoured account takeover, investment/romance scam
  ("yahoo") inflows, mule-network fan-in/fan-out, and structuring under the
  N5m / N10m reporting thresholds are injected as labelled fraud typologies.
* Credit labels come from income stability, inflow/outflow ratio, gambling
  merchant exposure and loan-app stacking behaviour.

The generator is deterministic given a seed so training runs are reproducible.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .schemas import AccountProfile, Transaction

BANKS = [
    "AccessBank", "GTBank", "Zenith", "UBA", "FirstBank", "Kuda",
    "OPay", "PalmPay", "Moniepoint", "Sterling", "Fidelity", "UnionBank",
]
NEOBANKS = {"Kuda", "OPay", "PalmPay", "Moniepoint"}
STATES = [
    "Lagos", "Abuja FCT", "Kano", "Rivers", "Oyo", "Kaduna", "Enugu",
    "Delta", "Anambra", "Ogun", "Edo", "Borno", "Imo", "Akwa Ibom",
]
AGE_BANDS = ["18-24", "25-34", "35-44", "45-54", "55+"]
CHANNELS = ["nip_instant", "ussd", "pos", "web", "atm", "agent"]
TXN_TYPES = ["p2p", "bill", "airtime", "pos_purchase", "cash_out", "salary", "transfer_out"]
GAMBLING_MERS = ["MCH_BET9JA", "MCH_SPORTYBET", "MCH_1XBET", "MCH_NAIRABET"]
LOAN_APPS = ["MCH_CARBON", "MCH_FAIRMONEY", "MCH_BRANCH", "MCH_PALMCREDIT", "MCH_RENWAVE"]
UTILITIES = ["MCH_IKEJA_ELECTRIC", "MCH_EKEDC", "MCH_DSTV", "MCH_GOTV", "MCH_MTN_AIRTIME", "MCH_AIRTEL"]

FRAUD_TYPOLOGIES = [
    "account_takeover",
    "social_engineering_scam",
    "sim_swap_drain",
    "mule_fan_in_out",
    "structuring",
    "card_not_present",
    "velocity_burst",
]


def _round_ngn(rng: np.random.Generator, amount: float, p_round: float = 0.45) -> float:
    if rng.random() < p_round:
        for base in (10000, 5000, 1000, 500, 100):
            if amount >= base * 2:
                return float(round(amount / base) * base)
    return float(round(amount, 2))


class NigerianPaymentsGenerator:
    def __init__(self, seed: int = 42):
        self.rng = np.random.default_rng(seed)
        self.seed = seed

    # ------------------------------------------------------------------ accounts
    def generate_accounts(self, n_accounts: int, mule_rate: float = 0.012) -> list[AccountProfile]:
        rng = self.rng
        accounts: list[AccountProfile] = []
        # income distribution: mass at informal/low income, tail of high earners
        income = np.exp(rng.normal(np.log(180_000), 0.9, n_accounts))
        income = np.clip(income, 15_000, 8_000_000)
        mule_flags = rng.random(n_accounts) < mule_rate
        for i in range(n_accounts):
            bank = BANKS[i % len(BANKS)] if i < len(BANKS) else rng.choice(BANKS, p=self._bank_weights())
            kyc = int(rng.choice([1, 2, 3], p=[0.3, 0.45, 0.25]))
            accounts.append(AccountProfile(
                account_id=f"NGACC{i:07d}",
                bank=str(bank),
                state=str(rng.choice(STATES, p=self._state_weights())),
                age_band=str(rng.choice(AGE_BANDS, p=[0.22, 0.34, 0.22, 0.13, 0.09])),
                kyc_tier=kyc,
                monthly_income_ngn=float(round(income[i], 2)),
                opened_days=int(rng.integers(3, 3650)),
                is_mule=int(mule_flags[i]),
            ))
        return accounts

    @staticmethod
    def _bank_weights():
        # neo-banks + big-4 dominate retail volumes
        w = np.array([0.16, 0.13, 0.10, 0.09, 0.09, 0.08, 0.11, 0.08, 0.07, 0.04, 0.03, 0.02])
        return w / w.sum()

    @staticmethod
    def _state_weights():
        w = np.array([0.24, 0.09, 0.07, 0.07, 0.06, 0.05, 0.05, 0.05, 0.05, 0.06, 0.05, 0.04, 0.06, 0.06])
        return w / w.sum()

    # ------------------------------------------------------------- transactions
    def generate_transactions(
        self,
        accounts: list[AccountProfile],
        n_txns: int,
        start_day: int = 0,
        horizon_days: int = 30,
        fraud_rate: float = 0.02,
    ) -> pd.DataFrame:
        rng = self.rng
        n = len(accounts)
        acct_ids = [a.account_id for a in accounts]
        banks = {a.account_id: a.bank for a in accounts}
        income = {a.account_id: a.monthly_income_ngn for a in accounts}
        kyc = {a.account_id: a.kyc_tier for a in accounts}
        is_mule = {a.account_id: a.is_mule for a in accounts}

        # --- legit base traffic -------------------------------------------
        n_legit = int(n_txns * (1 - fraud_rate))
        src_idx = rng.integers(0, n, n_legit)
        dst_idx = rng.integers(0, n, n_legit)
        same = src_idx == dst_idx
        dst_idx[same] = (dst_idx[same] + 1) % n

        # activity is heavy-tailed: some accounts transact far more
        activity = rng.pareto(1.5, n) + 0.1
        src_idx = rng.choice(n, n_legit, p=activity / activity.sum())

        hours = rng.choice(24, n_legit, p=self._hour_weights())
        day_offsets = rng.integers(start_day, start_day + horizon_days, n_legit)
        # salary-cycle bump: more volume 25th->2nd
        salary_bump = ((day_offsets % 30) >= 24) | ((day_offsets % 30) <= 2)
        channels = rng.choice(CHANNELS, n_legit, p=[0.42, 0.22, 0.14, 0.09, 0.05, 0.08])
        txn_types = rng.choice(TXN_TYPES, n_legit, p=[0.38, 0.12, 0.10, 0.16, 0.10, 0.04, 0.10])

        src = np.array(acct_ids)[src_idx]
        dst = np.array(acct_ids)[dst_idx]
        # some dst become merchants
        is_merch = np.isin(txn_types, ["bill", "airtime", "pos_purchase"])
        merch_pool = np.array(UTILITIES + GAMBLING_MERS + LOAN_APPS)
        dst[is_merch] = rng.choice(merch_pool, is_merch.sum())

        amounts = np.empty(n_legit)
        for j in range(n_legit):
            inc = income[src[j]]
            base = rng.lognormal(mean=np.log(max(inc, 30_000) / 22), sigma=1.05)
            if txn_types[j] == "airtime":
                base = rng.choice([100, 200, 500, 1000, 2000, 5000])
            elif txn_types[j] == "salary":
                base = inc
            cap = {1: 300_000, 2: 2_000_000, 3: 25_000_000}[kyc[src[j]]]
            amounts[j] = _round_ngn(rng, min(base, cap), 0.45 if txn_types[j] == "p2p" else 0.12)

        rows = []
        devices = {a: f"DEV{rng.integers(0, max(2, n // 3)):08d}" for a in acct_ids}
        for j in range(n_legit):
            ts = pd.Timestamp("2026-01-01", tz="UTC") + pd.Timedelta(days=int(day_offsets[j]), hours=int(hours[j]), minutes=int(rng.integers(0, 60)))
            rows.append(Transaction(
                txn_id=f"TXN{self.seed}{start_day}{j:09d}",
                ts=ts.isoformat(),
                src_account=str(src[j]),
                dst_account=str(dst[j]),
                amount_ngn=float(amounts[j]),
                channel=str(channels[j]),
                txn_type=str(txn_types[j]),
                src_bank=banks[src[j]],
                dst_bank=banks.get(str(dst[j]), "MERCHANT"),
                device_id=devices[src[j]],
                ip_country="NG" if rng.random() > 0.004 else str(rng.choice(["GH", "KE", "GB", "US"])),
                is_cross_border=bool(str(dst[j]).startswith("NGACC") is False and rng.random() < 0.02),
            ))

        # --- fraud injections ----------------------------------------------
        n_fraud = n_txns - n_legit
        per_typology = max(1, n_fraud // len(FRAUD_TYPOLOGIES))
        f_j = 0
        for typology in FRAUD_TYPOLOGIES:
            rows.extend(self._inject(typology, per_typology, acct_ids, banks, income, is_mule, devices, start_day, horizon_days))
            f_j += per_typology

        df = pd.DataFrame([r.__dict__ for r in rows])
        return df.sample(frac=1.0, random_state=self.seed).reset_index(drop=True)

    @staticmethod
    def _hour_weights():
        # Nigerian retail curve: quiet 1-5am, peaks 9-11am and 6-9pm
        w = np.array([
            0.010, 0.005, 0.004, 0.004, 0.006, 0.012,   # 0-5
            0.025, 0.045, 0.065, 0.080, 0.082, 0.075,   # 6-11
            0.068, 0.062, 0.058, 0.055, 0.052, 0.050,   # 12-17
            0.058, 0.066, 0.070, 0.058, 0.040, 0.022,   # 18-23
        ])
        return w / w.sum()

    def _inject(self, typology: str, k: int, acct_ids, banks, income, is_mule, devices, start_day, horizon_days) -> list[Transaction]:
        rng = self.rng
        out: list[Transaction] = []
        n = len(acct_ids)
        victims = rng.integers(0, n, k)
        base_ts = pd.Timestamp("2026-01-01", tz="UTC")

        for j in range(k):
            v = victims[j]
            src = acct_ids[v]
            mule_candidates = [a for a in acct_ids if is_mule.get(a, 0) == 1]
            mule = str(rng.choice(mule_candidates)) if mule_candidates else acct_ids[(v + 7) % n]
            day = start_day + int(rng.integers(0, horizon_days))

            if typology == "account_takeover":
                # new device, foreign IP, night, rapid drain toward mule
                hour = int(rng.choice([1, 2, 3, 4]))
                amt = _round_ngn(rng, min(income[src] * rng.uniform(0.3, 0.95), 4_900_000))
                dev = f"DEV_UNKNOWN{rng.integers(0, 99999):06d}"
                ip = str(rng.choice(["RU", "GB", "US", "AE"]))
                channel, ttype, dst = "web", "transfer_out", mule
            elif typology == "social_engineering_scam":
                # victim willingly sends to scammer (investment/romance), daytime, own device
                hour = int(rng.integers(9, 21))
                amt = _round_ngn(rng, rng.lognormal(np.log(150_000), 1.0), 0.55)
                dev, ip = devices[src], "NG"
                channel, ttype, dst = str(rng.choice(["nip_instant", "ussd"])), "p2p", mule
            elif typology == "sim_swap_drain":
                # USSD from swapped SIM, sequential draining
                hour = int(rng.choice([0, 1, 2, 22, 23]))
                amt = _round_ngn(rng, min(income[src] * rng.uniform(0.1, 0.4), 500_000), 0.7)
                dev = f"DEV_SWAP{rng.integers(0, 9999):06d}"
                ip = "NG"
                channel, ttype, dst = "ussd", "transfer_out", mule
            elif typology == "mule_fan_in_out":
                # mule account receives many mid-size inflows, forwards within hours
                src = mule if rng.random() < 0.5 else acct_ids[rng.integers(0, n)]
                dst = mule if src != mule else acct_ids[rng.integers(0, n)]
                hour = int(rng.integers(0, 24))
                amt = _round_ngn(rng, rng.lognormal(np.log(85_000), 0.7), 0.3)
                dev, ip = devices[src], "NG"
                channel, ttype = "nip_instant", "p2p"
            elif typology == "structuring":
                # just under N5m reporting threshold, repeated
                hour = int(rng.integers(8, 18))
                amt = float(rng.uniform(4_500_000, 4_990_000))
                dev, ip = devices[src], "NG"
                channel, ttype, dst = "nip_instant", "transfer_out", mule
            elif typology == "card_not_present":
                hour = int(rng.choice([2, 3, 13, 14]))
                amt = _round_ngn(rng, rng.lognormal(np.log(45_000), 0.9))
                dev, ip = f"DEV_CNP{rng.integers(0, 99999):06d}", str(rng.choice(["NG", "US", "GB"]))
                channel, ttype, dst = "web", "pos_purchase", str(rng.choice(["MCH_INTL_STORE", "MCH_CRYPTO_DESK"]))
            else:  # velocity_burst
                hour = int(rng.integers(0, 24))
                amt = _round_ngn(rng, rng.lognormal(np.log(25_000), 0.6), 0.2)
                dev, ip = devices[src], "NG"
                channel, ttype, dst = "nip_instant", "p2p", mule

            ts = base_ts + pd.Timedelta(days=day, hours=hour, minutes=int(rng.integers(0, 60)), seconds=int(rng.integers(0, 60)))
            out.append(Transaction(
                txn_id=f"TXNF{self.seed}{typology[:4]}{j:08d}",
                ts=ts.isoformat(),
                src_account=src,
                dst_account=str(dst),
                amount_ngn=float(amt),
                channel=channel,
                txn_type=ttype,
                src_bank=banks[src],
                dst_bank=banks.get(str(dst), "MERCHANT"),
                device_id=dev,
                ip_country=ip,
                is_cross_border=ip != "NG",
                label_fraud=1,
                fraud_typology=typology,
            ))
        return out

    # ------------------------------------------------------------------ credit
    def assign_credit_labels(self, accounts: list[AccountProfile], txns: pd.DataFrame) -> list[AccountProfile]:
        """Default label from observable financial-behaviour stress signals."""
        rng = self.rng
        out: list[AccountProfile] = []
        grp = txns.groupby("src_account")
        for a in accounts:
            g = grp.get_group(a.account_id) if a.account_id in grp.groups else None
            if g is None or len(g) == 0:
                stress = rng.uniform(0.1, 0.4)
            else:
                outflow = g["amount_ngn"].sum()
                gambling = g["dst_account"].isin(GAMBLING_MERS).sum()
                loan_stacking = g["dst_account"].isin(LOAN_APPS).sum()
                spend_ratio = outflow / max(a.monthly_income_ngn, 1.0)
                night_ratio = (pd.to_datetime(g["ts"]).dt.hour.isin([0, 1, 2, 3, 4])).mean()
                stress = (
                    0.30 * min(spend_ratio / 6.0, 1.0)
                    + 0.25 * min(gambling / 8.0, 1.0)
                    + 0.25 * min(loan_stacking / 4.0, 1.0)
                    + 0.10 * night_ratio
                    + 0.10 * (1 if a.kyc_tier == 1 else 0)
                )
            p_default = float(np.clip(stress * rng.uniform(0.5, 1.5), 0.01, 0.9))
            default = int(rng.random() < p_default)
            out.append(AccountProfile(**{**a.__dict__, "credit_default": default}))
        return out
