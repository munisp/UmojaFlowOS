"""Neo4j integration for the transaction graph.

Closes the gap "no Neo4j": the Lakehouse gold graph snapshot can be loaded
into Neo4j for graph exploration, investigation queries, and GDS-based
analytics. When a Neo4j bolt URI is configured this streams the graph with
batched Cypher; otherwise it writes an idempotent .cypher load script so the
integration is verifiable without a live server.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from .graph_builder import TransactionGraph

CYPHER_HEADER = """// UmojaFlowOS mule-detection graph load (idempotent)
CREATE CONSTRAINT account_id IF NOT EXISTS FOR (a:Account) REQUIRE a.accountId IS UNIQUE;
"""
NODE_BATCH_STMT = (
    "UNWIND $batch AS row "
    "MERGE (a:Account {accountId: row.id}) SET a.riskScore = row.risk, a.label = row.label"
)
EDGE_BATCH_STMT = (
    "UNWIND $batch AS row "
    "MATCH (s:Account {accountId: row.src}), (d:Account {accountId: row.dst}) "
    "MERGE (s)-[r:SENT_TO]->(d) SET r.logAmount = row.log_amount, r.txnCount = row.count"
)


def graph_to_cypher_file(graph: TransactionGraph, risk_scores: np.ndarray | None, path: Path | str) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    risk_scores = risk_scores if risk_scores is not None else np.zeros(graph.num_nodes)
    lines = [CYPHER_HEADER]
    for i, nid in enumerate(graph.node_ids):
        lines.append(
            f'MERGE (a:Account {{accountId: "{nid}"}}) '
            f'SET a.riskScore = {float(risk_scores[i]):.6f}, a.label = {int(graph.y[i])};'
        )
    for j in range(graph.edge_index.shape[1]):
        s = graph.node_ids[int(graph.edge_index[0, j])]
        d = graph.node_ids[int(graph.edge_index[1, j])]
        lines.append(
            f'MATCH (s:Account {{accountId: "{s}"}}), (d:Account {{accountId: "{d}"}}) '
            f'MERGE (s)-[r:SENT_TO]->(d) SET r.logAmount = {float(graph.edge_attr[j, 0]):.6f}, '
            f'r.txnCount = {float(graph.edge_attr[j, 1]):.2f};'
        )
    path.write_text("\n".join(lines))
    return path


def load_graph_to_neo4j(
    graph: TransactionGraph,
    risk_scores: np.ndarray | None,
    bolt_uri: str,
    auth: tuple[str, str],
    batch_size: int = 2000,
) -> dict:
    """Stream the graph into Neo4j. Raises if the server is unreachable —
    callers in offline mode should use graph_to_cypher_file instead."""
    from neo4j import GraphDatabase  # optional dependency

    risk_scores = risk_scores if risk_scores is not None else np.zeros(graph.num_nodes)
    driver = GraphDatabase.driver(bolt_uri, auth=auth)
    n_nodes = n_edges = 0
    try:
        with driver.session() as session:
            session.run("CREATE CONSTRAINT account_id IF NOT EXISTS FOR (a:Account) REQUIRE a.accountId IS UNIQUE")
            rows = [{"id": nid, "risk": float(risk_scores[i]), "label": int(graph.y[i])}
                    for i, nid in enumerate(graph.node_ids)]
            for start in range(0, len(rows), batch_size):
                batch = rows[start:start + batch_size]
                session.execute_write(lambda tx, b: tx.run(NODE_BATCH_STMT, batch=b).consume(), batch)
                n_nodes += len(batch)
            edges = [{
                "src": graph.node_ids[int(graph.edge_index[0, j])],
                "dst": graph.node_ids[int(graph.edge_index[1, j])],
                "log_amount": float(graph.edge_attr[j, 0]),
                "count": float(graph.edge_attr[j, 1]),
            } for j in range(graph.edge_index.shape[1])]
            for start in range(0, len(edges), batch_size):
                batch = edges[start:start + batch_size]
                session.execute_write(lambda tx, b: tx.run(EDGE_BATCH_STMT, batch=b).consume(), batch)
                n_edges += len(batch)
    finally:
        driver.close()
    return {"nodes_loaded": n_nodes, "edges_loaded": n_edges, "bolt_uri": bolt_uri}
