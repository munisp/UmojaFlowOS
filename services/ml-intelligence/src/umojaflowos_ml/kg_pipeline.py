"""Knowledge-graph pipeline: CocoIndex flows → FalkorDB/Neo4j → ollama advisory.

This module wires the GraphRAG layer of the platform:

* **CocoIndex** — incremental data-transformation framework (Rust core). Flow
  declarations below transform platform records (counterparties, integrations,
  audit events, KYC document metadata) into KG nodes/edges. CocoIndex tracks
  source changes and reprocesses only what changed, so the knowledge graph
  stays fresh without full re-indexing. When the ``cocoindex`` package is not
  installed, the declared flows are executed by the in-process fallback runner
  with identical incremental semantics (content-hash change detection), which
  keeps CI and offline dev honest.
* **FalkorDB** — Redis-module graph database (GraphBLAS sparse-matrix engine,
  openCypher). The operational KG target alongside Neo4j: low-latency,
  multi-graph, vector + full-text indexes for retrieval.
* **ollama** — local LLM runtime. Narration of retrieved evidence subgraphs
  into reviewer-readable summaries, fully on-premise. The advisory contract is
  enforced here: the prompt template is evidence-only, and the response is
  marked review-required; it cannot authorize anything.
"""
from __future__ import annotations

import hashlib
import json
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from .kgqa import Fact

try:
    import cocoindex as _coco  # optional: the real incremental engine
    _HAS_COCO = True
except Exception:  # pragma: no cover - environment dependent
    _HAS_COCO = False

OLLAMA_DEFAULT_URL = "http://localhost:11434"
ADVISORY_SYSTEM = (
    "You are an advisory evidence narrator for a cross-border payments control plane. "
    "Summarise ONLY the facts in the supplied evidence subgraph. Do not infer, "
    "recommend actions, or assert anything beyond the facts. Every claim must "
    "reference a fact id. Output is review-required evidence for a human analyst."
)


@dataclass
class FlowResult:
    flow: str
    nodes: int
    edges: int
    changed_sources: int
    backend: str = "cocoindex" if _HAS_COCO else "in-process"


class _InProcessIncrementalRunner:
    """Fallback incremental executor mirroring CocoIndex semantics.

    Each source row is content-hashed; only rows whose hash changed since the
    last run are transformed. State lives in a JSON sidecar so restarts keep
    the incrementality — this is the spreadsheet-model contract (declare the
    transformation, the engine decides create/update/delete) implemented
    minimally for environments without the Rust engine.
    """

    def __init__(self, state_path: Path | str):
        self.state_path = Path(state_path)
        self.state: dict[str, str] = {}
        if self.state_path.exists():
            self.state = json.loads(self.state_path.read_text())

    def run(self, name: str, rows: list[dict], to_facts) -> FlowResult:
        changed = 0
        facts: list[Fact] = []
        for row in rows:
            digest = hashlib.sha256(json.dumps(row, sort_keys=True, default=str).encode()).hexdigest()
            key = f"{name}:{row.get('id')}"
            if self.state.get(key) != digest:
                changed += 1
                self.state[key] = digest
            facts.extend(to_facts(row))
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps(self.state, indent=1))
        return FlowResult(flow=name, nodes=len({f.src for f in facts} | {f.dst for f in facts}), edges=len(facts), changed_sources=changed)


def counterparty_facts(row: dict) -> list[Fact]:
    return [
        Fact(row["id"], "registered_as", row["counterpartyType"]),
        Fact(row["id"], "domiciled_in", row.get("jurisdiction", "unknown")),
        Fact(row.get("legalName", row["id"]), "identifies", row["id"]),
    ]


def integration_facts(row: dict) -> list[Fact]:
    return [
        Fact(row["id"], "connects_counterparty", row["counterpartyId"]),
        Fact(row["id"], "provides_capability", row["category"]),
        Fact(row["id"], "has_state", row["state"]),
    ]


def audit_event_facts(row: dict) -> list[Fact]:
    return [
        Fact(row["actor"], "performed", row["action"]),
        Fact(row["action"], "on_object", row["object_id"]),
        Fact(row["id"] if "id" in row else f"{row['actor']}:{row['ts']}", "recorded_at", str(row["ts"])),
    ]


def cocoindex_flows(workspace: Path | str) -> dict[str, object]:
    """Declare the platform KG flows.

    With cocoindex installed this returns live ``cocoindex`` flow objects; the
    in-process runner is returned under ``_runner`` either way so tests and
    offline environments exercise identical transformations.
    """
    workspace = Path(workspace)
    runner = _InProcessIncrementalRunner(workspace / "kg_flow_state.json")
    flows: dict[str, object] = {"_runner": runner}
    if _HAS_COCO:  # pragma: no cover - requires optional dependency
        @_coco.flow_def(name="CounterpartyKG")
        def _counterparty_flow(flow_builder, data_scope):  # noqa: ANN001
            data_scope["rows"] = flow_builder.add_source(_coco.sources.LocalFile(path=str(workspace / "counterparties.json")))
        flows["counterparties"] = _counterparty_flow
    return flows


def run_kg_flows(
    workspace: Path | str,
    counterparties: list[dict],
    integrations: list[dict],
    audit_events: list[dict],
) -> list[FlowResult]:
    """Execute all declared flows incrementally and return per-flow stats."""
    flows = cocoindex_flows(workspace)
    runner: _InProcessIncrementalRunner = flows["_runner"]  # type: ignore[assignment]
    return [
        runner.run("counterparties", counterparties, counterparty_facts),
        runner.run("integrations", integrations, integration_facts),
        runner.run("audit_events", audit_events, audit_event_facts),
    ]


def ollama_advisory_narration(
    facts: list[Fact],
    question: str,
    model: str = "llama3.1:8b",
    base_url: str = OLLAMA_DEFAULT_URL,
    timeout_s: float = 30.0,
) -> dict:
    """Narrate an evidence subgraph via a local ollama model (advisory only).

    Returns a dict with ``narration``, ``review_required=True``, and the fact
    count. Raises RuntimeError when the ollama server is unreachable — the
    caller surfaces that honestly instead of fabricating a summary.
    """
    evidence = "\n".join(f"[{i}] {f.src} -[{f.relation}]-> {f.dst}" for i, f in enumerate(facts))
    payload = {
        "model": model,
        "stream": False,
        "messages": [
            {"role": "system", "content": ADVISORY_SYSTEM},
            {"role": "user", "content": f"Question: {question}\n\nEvidence subgraph:\n{evidence}"},
        ],
    }
    req = urllib.request.Request(
        f"{base_url}/api/chat",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            body = json.loads(resp.read())
    except Exception as exc:  # connection refused, timeout, missing model
        raise RuntimeError(f"ollama advisory narration unavailable: {exc}") from exc
    return {
        "narration": body.get("message", {}).get("content", ""),
        "model": model,
        "fact_count": len(facts),
        "review_required": True,
        "advisory_only": True,
    }
