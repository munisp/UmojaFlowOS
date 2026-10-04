# UmojaFlowOS — Knowledge-Graph Stack, MCMC Bayesian Layer, and Insider-Threat Fusion

**Date:** 2026-09-25 · **Scope:** CocoIndex, EPR-KGQA, FalkorDB, ollama, ART, MCMC; GNN + Neo4j integration; insider theft / collusion / abuse / embezzlement countermeasures. **Status:** implemented in `services/ml-intelligence` (33/33 tests passing).

---

## 1. What each technology is, and what it adds to this platform

| Technology | What it is | Value to UmojaFlowOS | Where it lives |
|---|---|---|---|
| **CocoIndex** | Open-source incremental data-transformation framework (Rust core, dataflow model; developers declare transformations, the engine handles create/update/delete with change tracking and lineage) | Keeps the operational knowledge graph **fresh without full re-indexing**: when a counterparty, integration, or audit record changes, only that row is re-transformed into KG facts. Lineage is built-in, which matches the platform's attributable-evidence rule | `kg_pipeline.py` — flows for counterparties / integrations / audit events; in-process fallback runner with identical incremental semantics (content-hash change detection) for environments without the Rust engine |
| **EPR (Evidence Pattern Retrieval) KGQA** | Retrieval method that indexes *atomic adjacency patterns* of entity pairs, retrieves patterns relevant to a question, enumerates combinations into candidate evidence patterns, scores them with a small neural model, and extracts the best evidence subgraph (+10 F1 on ComplexWebQuestions in the paper) | Lets reviewers ask questions like "which active integrations connect counterparty X to payment rails" and receive a **grounded evidence subgraph** — never free-text hallucination. The answer is limited to retrieved facts, which is exactly the evidence-only boundary the platform enforces | `kgqa.py` — `EvidencePatternIndex`, `PatternScorer`, `platform_facts_from_records` |
| **FalkorDB** | Redis-module graph database (fork of RedisGraph); sparse adjacency matrices + GraphBLAS linear algebra; openCypher; sub-millisecond multi-hop traversal; multi-graph; vector + full-text indexes; RESP and Bolt protocols | The **low-latency KG serving tier** for GraphRAG and interactive investigation, complementing Neo4j (deep analytics/GDS). Runs beside existing Redis infrastructure; per-tenant graphs map cleanly to corridors | `falkordb_export.py`, `infra/falkordb/docker-compose.yaml` |
| **ollama** | Local LLM runtime (fully on-premise) | Narrates retrieved evidence subgraphs into reviewer-readable summaries **without data leaving the deployment** — important for CBN-sandbox confidentiality. The advisory contract is enforced in code: evidence-only system prompt, `review_required: true`, `advisory_only: true` on every response; unreachable server raises instead of fabricating | `kg_pipeline.ollama_advisory_narration` |
| **ART (Adversarial Robustness Toolbox, IBM / LF AI & Data)** | Peer-reviewed adversarial-ML library: 55+ attacks (FGSM, PGD, C&W, poisoning, extraction, inference) and 30+ defences across PyTorch/sklearn/etc. | Fraud models face adversaries who **perturb transaction features to evade detection**. ART evaluation answers: at ε-perturbation of amount/timing/device features, how much fraud recall survives? Includes PGD adversarial training to harden models and a poisoning-suspect screen for planted training rows — the latter directly relevant to insider data poisoning | `adversarial.py` — uses ART when installed (`robustness` extra), otherwise equivalent pure-PyTorch FGSM/PGD so the gate runs in CI on CPU |
| **MCMC (Markov Chain Monte Carlo)** | Bayesian posterior sampling — here, adaptive Metropolis-Hastings for Bayesian logistic regression, pure NumPy/CPU, seeded and persisted as `.npz` | Turns point fraud/insider scores into **posterior predictive distributions with credible intervals**. A wide interval tells the reviewer "the model is uncertain — collect more evidence", which a point score cannot express. Also fuses insider-evidence channels with calibrated uncertainty | `bayesian.py` — `metropolis_hastings_logistic`, `calibrate_scores_mcmc`, persisted `MCMCSampleSet` |

### How the pieces compose

```
PostgreSQL records ──► CocoIndex flows (incremental) ──► KG facts ──► FalkorDB (serving) / Neo4j (GDS analytics)
                                                              │
                                    question ──► EPR retrieval ──► evidence subgraph ──► ollama narration (advisory, review-required)
                                                              │
MuleGraphSAGE embeddings ─► insider.py signals (SoD/collusion/time/embezzlement) ─► MCMC fusion ─► InsiderRiskAssessment (mean + 95% CI)
FraudNet/CreditNet ──► ART evasion evaluation ──► adversarial training ──► hardened registry promotion
```

## 2. GNN + Neo4j + MCMC integration status

* **GNN (MuleGraphSAGE):** real PyTorch model, trained weights, CPU inference — unchanged, verified in turn 1. Embeddings are now additionally consumed by `insider.gnn_embedding_anomaly` (Mahalanobis distance to the benign centroid) as an insider-risk channel.
* **Neo4j:** `neo4j_export.py` streams the gold graph over Bolt or emits an idempotent `.cypher` load script; GDS plugin enabled in `infra/neo4j/docker-compose.yaml`. FalkorDB now sits beside it as the low-latency serving tier (`falkordb_export.py`, compose under `infra/falkordb/`).
* **MCMC:** new `bayesian.py` — adaptive Metropolis-Hastings, seeded, CPU-only, posterior persisted to `.npz`. Used by insider fusion and available as a calibration layer over any model score (`calibrate_scores_mcmc` prepends the deep model's logit as the first regressor, so the Bayesian layer learns how much to trust the point model).

## 3. Insider theft, collusion, abuse of property/time, fraud, embezzlement

### Process controls (already enforced by the platform, mined here for evidence)

1. **Separation of duties** — originator ≠ approver on payment orders, treasury recommendations, licences, credential activations, regulatory reports. `mine_sod_violations` audits the immutable activity trail for violations.
2. **Four-eyes privileged actions + immutable attributable records** — every privileged action is an attributable event; nothing is hard-deleted.
3. **Credential activation requires a verified provider health check** — an insider cannot activate a rail unilaterally.

### Detection channels (`insider.py`)

| Channel | Typology detected | Method |
|---|---|---|
| `sod_violation` | Self-approval fraud | Audit-trail join of originator/approver pairs per object |
| `collusion` | Operator–vendor capture rings | Actor-set exclusivity clustering on the operator–object incidence graph (captured objects worked by ≤2 operators, dominated ≥80% by one) |
| `time_abuse` | Abuse of company time / off-hours misuse | Off-hours (00:00–05:00) burst detection vs the operator's own off-hours rate across the observation window |
| `embezzlement_pattern` | Embezzlement, skimming, float theft | Round-trip value cycles within 7d; dormant-account (≥90d) reactivation followed by ≥70% lifetime-volume drain within 24h; structuring at 90–99% of the approval threshold |

### Fraud fusion

Each channel's partial score plus the GNN embedding anomaly is fused by the MCMC Bayesian logistic layer into `InsiderRiskAssessment{ posterior_mean, ci_lower, ci_upper, band }`. Trained on `synthetic_insider.py` scenarios (SoD capture, collusion rings, night-shift abuse, round-trips, structuring, dormant drains — labelled synthetic data; stated as such on all metrics). **A high posterior with a wide interval means "investigate with more data", never "guilty" — disposition is always a human compliance decision.**

## 4. Honest limitations

* Insider fusion is trained on synthetic scenarios; it must be re-calibrated on real labelled review outcomes before any weight is placed on absolute probabilities.
* ART evasion results are bounded-ε evaluations on synthetic feature distributions; they measure robustness of the current model, not of the deployed decision path.
* ollama narration quality depends on the local model chosen; the contract guarantees grounding and review-required status, not prose quality.
* CocoIndex's real Rust engine is an optional extra; the in-process runner preserves incremental semantics for CI/offline but is not a substitute at production ingestion rates.
* MCMC here is Metropolis-Hastings (robust, dependency-free) rather than NUTS/HMC; for higher-dimensional posteriors, PyMC/numpyro is the upgrade path.
