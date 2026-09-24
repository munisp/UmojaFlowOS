"""Production-DB -> Lakehouse -> training pipeline.

Closes the gap "no data pipeline from production DB to training":

  bronze  raw extracts (payments/transactions pulled from PostgreSQL, or the
          synthetic Nigerian generator in non-production environments)
  silver  cleaned, typed, deduplicated parquet partitioned by day
  gold    model-ready feature frames and graph snapshots

Parquet layout mirrors the reporting service's lakehouse conventions so the
same catalog/DuckDB tooling can query it. All writes are idempotent per
(lake, day) partition.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from .features import build_feature_frame, credit_feature_frame
from .graph_builder import build_graph
from .schemas import utcnow
from .synthetic_nigeria import NigerianPaymentsGenerator


@dataclass
class LakehouseSnapshot:
    run_id: str
    bronze_path: Path
    silver_path: Path
    gold_path: Path
    n_transactions: int
    n_accounts: int


def extract_from_postgres(dsn: str, since_iso: str, until_iso: str) -> pd.DataFrame:
    """Pull settled transaction records from the production read replica.

    Expects a reporting view `ml_training_transactions` with the columns used
    by the Transaction schema. Read-only; never writes back to production.
    """
    import psycopg  # optional: only needed in production mode

    query = """
        SELECT txn_id, ts, src_account, dst_account, amount_ngn, channel,
               txn_type, src_bank, dst_bank, device_id, ip_country,
               is_cross_border, label_fraud, fraud_typology
        FROM ml_training_transactions
        WHERE ts >= %s AND ts < %s
    """
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute(query, (since_iso, until_iso))
            cols = [d.name for d in cur.description]
            rows = cur.fetchall()
    return pd.DataFrame(rows, columns=cols)


class MLLakehouse:
    def __init__(self, root: Path | str):
        self.root = Path(root)
        for layer in ("bronze", "silver", "gold"):
            (self.root / layer).mkdir(parents=True, exist_ok=True)

    def _partition_path(self, layer: str, name: str, day: str) -> Path:
        p = self.root / layer / name / f"day={day}"
        p.mkdir(parents=True, exist_ok=True)
        return p

    def ingest_bronze(self, txns: pd.DataFrame, accounts: pd.DataFrame, day: str) -> Path:
        p = self._partition_path("bronze", "transactions", day)
        txns.to_parquet(p / "transactions.parquet", index=False)
        ap = self._partition_path("bronze", "accounts", day)
        accounts.to_parquet(ap / "accounts.parquet", index=False)
        return p

    def refine_silver(self, day: str) -> Path:
        src = self._partition_path("bronze", "transactions", day) / "transactions.parquet"
        t = pd.read_parquet(src)
        t = t.drop_duplicates(subset=["txn_id"])
        t["amount_ngn"] = t["amount_ngn"].astype(float).clip(lower=0.01)
        t["ts"] = pd.to_datetime(t["ts"], utc=True)
        t = t[t["amount_ngn"] < 1e9]  # reject corrupt rows
        p = self._partition_path("silver", "transactions", day)
        t.to_parquet(p / "transactions.parquet", index=False)
        return p

    def build_gold(self, day: str, accounts: pd.DataFrame, account_labels: dict[str, int], kyc_by_account: dict[str, int]) -> Path:
        t = pd.read_parquet(self._partition_path("silver", "transactions", day) / "transactions.parquet")
        p = self._partition_path("gold", "features", day)
        build_feature_frame(t, kyc_by_account).to_parquet(p / "fraud_features.parquet", index=False)
        credit_feature_frame(t, accounts).to_parquet(p / "credit_features.parquet", index=False)
        graph = build_graph(t, account_labels, kyc_by_account)
        import numpy as np
        np.savez_compressed(
            p / "graph_snapshot.npz",
            x=graph.x, edge_index=graph.edge_index, edge_attr=graph.edge_attr,
            y=graph.y, train_mask=graph.train_mask, val_mask=graph.val_mask,
            node_ids=np.array(graph.node_ids),
        )
        return p


def run_synthetic_pipeline(
    lakehouse_root: Path | str,
    n_accounts: int = 4000,
    n_txns: int = 120_000,
    day: str | None = None,
    seed: int = 42,
) -> tuple[LakehouseSnapshot, pd.DataFrame, pd.DataFrame]:
    """End-to-end: generate -> bronze -> silver -> gold. Returns frames too."""
    day = day or utcnow().date().isoformat()
    gen = NigerianPaymentsGenerator(seed=seed)
    accounts_raw = gen.generate_accounts(n_accounts)
    txns = gen.generate_transactions(accounts_raw, n_txns)
    accounts = pd.DataFrame([a.__dict__ for a in gen.assign_credit_labels(accounts_raw, txns)])

    lh = MLLakehouse(lakehouse_root)
    bronze = lh.ingest_bronze(txns, accounts, day)
    silver = lh.refine_silver(day)
    txns_clean = pd.read_parquet(Path(silver) / "transactions.parquet")
    account_labels = dict(zip(accounts["account_id"], accounts["is_mule"]))
    kyc_by_account = dict(zip(accounts["account_id"], accounts["kyc_tier"]))
    gold = lh.build_gold(day, accounts, account_labels, kyc_by_account)
    snapshot = LakehouseSnapshot(
        run_id=f"run-{day}-{seed}", bronze_path=Path(bronze), silver_path=Path(silver),
        gold_path=Path(gold), n_transactions=len(txns_clean), n_accounts=len(accounts),
    )
    return snapshot, txns_clean, accounts
