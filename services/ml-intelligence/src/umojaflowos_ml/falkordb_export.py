"""FalkorDB integration for the operational knowledge graph.

FalkorDB (the Redis-module graph database, openCypher + GraphBLAS sparse
matrix engine) is the low-latency KG target alongside Neo4j. The same
TransactionGraph / fact sets are exported either by streaming over the RESP
protocol when a FalkorDB server is configured, or — matching the Neo4j
exporter's pattern — as an idempotent openCypher load script so the
integration is verifiable without a live server.
"""
from __future__ import annotations

from pathlib import Path

from .graph_builder import TransactionGraph
from .kgqa import Fact

FALKOR_HEADER = """// UmojaFlowOS operational KG load for FalkorDB (idempotent, openCypher)
// Load with: redis-cli -p 6379 GRAPH.QUERY umoja_kg "<statement>"
"""


def facts_to_cypher(facts: list[Fact]) -> list[str]:
    lines = [FALKOR_HEADER]
    for f in facts:
        s = str(f.src).replace('"', "'")
        d = str(f.dst).replace('"', "'")
        rel = "".join(ch if ch.isalnum() else "_" for ch in f.relation).upper()
        lines.append(
            f'MERGE (a:Entity {{id: "{s}"}}) '
            f'MERGE (b:Entity {{id: "{d}"}}) '
            f'MERGE (a)-[:{rel}]->(b);'
        )
    return lines


def write_falkordb_load_script(facts: list[Fact], path: Path | str) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(facts_to_cypher(facts)))
    return path


def graph_facts(graph: TransactionGraph, risk_scores=None) -> list[Fact]:
    import numpy as np

    risk_scores = risk_scores if risk_scores is not None else np.zeros(graph.num_nodes)
    facts: list[Fact] = []
    for i, nid in enumerate(graph.node_ids):
        facts.append(Fact(nid, "has_risk_score", f"{float(risk_scores[i]):.6f}"))
    for j in range(graph.edge_index.shape[1]):
        s = graph.node_ids[int(graph.edge_index[0, j])]
        d = graph.node_ids[int(graph.edge_index[1, j])]
        facts.append(Fact(s, "sent_to", d, {"logAmount": float(graph.edge_attr[j, 0])}))
    return facts


def load_facts_to_falkordb(
    facts: list[Fact],
    host: str = "localhost",
    port: int = 6379,
    graph_name: str = "umoja_kg",
) -> dict:
    """Stream facts into FalkorDB via the RESP protocol.

    Raises RuntimeError when the server is unreachable: a silent fallback
    would let an operator believe the KG is populated when it is not.
    """
    try:
        import redis  # type: ignore
    except Exception as exc:  # pragma: no cover
        raise RuntimeError("redis client not installed; install with `pip install redis` or falkordb") from exc
    client = redis.Redis(host=host, port=port, socket_timeout=5)
    try:
        client.ping()
    except Exception as exc:
        raise RuntimeError(f"FalkorDB at {host}:{port} unreachable: {exc}") from exc
    written = 0
    for stmt in facts_to_cypher(facts)[1:]:
        client.execute_command("GRAPH.QUERY", graph_name, stmt)
        written += 1
    return {"graph": graph_name, "statements": written}
