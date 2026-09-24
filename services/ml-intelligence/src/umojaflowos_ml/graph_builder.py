"""Transaction-graph construction for the GNN mule-detection model.

Nodes are accounts; directed edges are aggregated money flows. The graph is
stored as plain numpy arrays (edge list + features) so training runs anywhere
PyTorch runs — no torch_geometric dependency, CPU-friendly.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

NODE_FEATURES = [
    "out_degree", "in_degree", "log_total_sent", "log_total_received",
    "fan_in_out_ratio", "night_ratio", "unique_devices", "passthrough_ratio",
    "avg_sent", "avg_received", "kyc_tier", "burst_max_1h",
]


@dataclass
class TransactionGraph:
    node_ids: list[str]
    x: np.ndarray                # (N, len(NODE_FEATURES)) float32
    edge_index: np.ndarray       # (2, E) int64  [src, dst]
    edge_attr: np.ndarray        # (E, 3) float32 [log_amount, count, recency_days]
    y: np.ndarray                # (N,) int64 node label: 1 = mule/fraud participant
    train_mask: np.ndarray
    val_mask: np.ndarray

    @property
    def num_nodes(self) -> int:
        return len(self.node_ids)


def build_graph(
    txns: pd.DataFrame,
    account_labels: dict[str, int],
    kyc_by_account: dict[str, int] | None = None,
    val_fraction: float = 0.2,
    seed: int = 42,
) -> TransactionGraph:
    t = txns[txns["dst_account"].str.startswith("NGACC")].copy()  # account-to-account only
    t["dt"] = pd.to_datetime(t["ts"], utc=True)

    nodes = sorted(set(t["src_account"]) | set(t["dst_account"]))
    idx = {a: i for i, a in enumerate(nodes)}
    n = len(nodes)

    sent = t.groupby("src_account")["amount_ngn"].agg(["sum", "count", "mean"])
    recv = t.groupby("dst_account")["amount_ngn"].agg(["sum", "count", "mean"])
    t["night"] = t["dt"].dt.hour.isin([0, 1, 2, 3, 4]).astype(int)
    night_ratio = t.groupby("src_account")["night"].mean()
    devices = t.groupby("src_account")["device_id"].nunique()
    t["hour_bin"] = t["dt"].dt.floor("h")
    burst = t.groupby(["src_account", "hour_bin"]).size().groupby("src_account").max()

    x = np.zeros((n, len(NODE_FEATURES)), dtype=np.float32)
    for a, i in idx.items():
        s_sum = float(sent["sum"].get(a, 0.0))
        r_sum = float(recv["sum"].get(a, 0.0))
        s_cnt = float(sent["count"].get(a, 0.0))
        r_cnt = float(recv["count"].get(a, 0.0))
        in_deg = r_cnt
        out_deg = s_cnt
        passthrough = min(r_sum, s_sum) / max(r_sum, s_sum, 1.0) if r_cnt >= 2 and s_cnt >= 2 else 0.0
        x[i] = np.array([
            out_deg, in_deg,
            np.log1p(s_sum), np.log1p(r_sum),
            in_deg / max(out_deg, 1.0),
            float(night_ratio.get(a, 0.0)),
            float(devices.get(a, 0.0)),
            passthrough,
            np.log1p(s_sum / max(s_cnt, 1.0)), np.log1p(r_sum / max(r_cnt, 1.0)),
            float((kyc_by_account or {}).get(a, 2)),
            float(burst.get(a, 0.0)),
        ], dtype=np.float32)

    # standardize node features
    mu, sd = x.mean(axis=0), x.std(axis=0) + 1e-6
    x = (x - mu) / sd

    flows = t.groupby(["src_account", "dst_account"]).agg(
        total=("amount_ngn", "sum"), count=("txn_id", "count"), last=("dt", "max")
    ).reset_index()
    ref = flows["last"].max()
    edge_index = np.zeros((2, len(flows)), dtype=np.int64)
    edge_attr = np.zeros((len(flows), 3), dtype=np.float32)
    for j, row in enumerate(flows.itertuples(index=False)):
        edge_index[0, j] = idx[row.src_account]
        edge_index[1, j] = idx[row.dst_account]
        edge_attr[j] = [
            np.log1p(row.total),
            min(float(row.count), 50.0),
            (ref - row.last).days,
        ]
    ea_mu, ea_sd = edge_attr.mean(axis=0), edge_attr.std(axis=0) + 1e-6
    edge_attr = (edge_attr - ea_mu) / ea_sd

    y = np.array([account_labels.get(a, 0) for a in nodes], dtype=np.int64)
    rng = np.random.default_rng(seed)
    perm = rng.permutation(n)
    n_val = int(n * val_fraction)
    val_mask = np.zeros(n, dtype=bool)
    train_mask = np.zeros(n, dtype=bool)
    val_mask[perm[:n_val]] = True
    train_mask[perm[n_val:]] = True

    return TransactionGraph(
        node_ids=nodes, x=x, edge_index=edge_index, edge_attr=edge_attr,
        y=y, train_mask=train_mask, val_mask=val_mask,
    )
