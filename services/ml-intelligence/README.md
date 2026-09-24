# UmojaFlowOS ML Intelligence

The real end-to-end AI/ML/DL/GNN stack for the platform: PyTorch models,
trained weights, executable training loops, Lakehouse integration, Ray
distributed compute, MLflow registry, A/B testing, drift monitoring and
continuous training.

> **Control boundary (unchanged platform invariant).** Every model output is
> **advisory risk evidence for human review**. No score in this service
> authorizes, rejects, or executes a payment, credit decision, identity
> decision, or regulatory submission. Inference responses carry
> `advisory_only: true` and `review_required: true`.

## What ships here

| Component | Path | Real? |
|---|---|---|
| Synthetic Nigerian payments generator | `src/umojaflowos_ml/synthetic_nigeria.py` | ✅ NIBSS-shaped distributions, 7 labelled fraud typologies, deterministic seeds |
| Feature engineering (train/serve identical) | `src/umojaflowos_ml/features.py` | ✅ 24 numeric + 4 categorical transaction features; 12 credit features |
| FraudNet — supervised fraud classifier | `src/umojaflowos_ml/models/fraud.py` | ✅ PyTorch MLP + embeddings, trained weights in `runtime/registry/` |
| CreditNet — multitask PD + score-band | `src/umojaflowos_ml/models/credit.py` | ✅ PyTorch, two heads, trained weights |
| MuleGraphSAGE — GNN mule detection | `src/umojaflowos_ml/models/gnn.py` | ✅ pure-PyTorch GraphSAGE (no torch_geometric), trained weights |
| FraudAutoencoder — deep anomaly detection | `src/umojaflowos_ml/models/autoencoder.py` | ✅ trained on legit-only traffic, validated on held-out fraud |
| Lakehouse bronze→silver→gold pipeline | `src/umojaflowos_ml/lakehouse.py` | ✅ parquet partitions; `extract_from_postgres` for production read replicas |
| Model registry + versioning | `src/umojaflowos_ml/registry.py` | ✅ local content-addressed registry + MLflow logging (`infra/mlflow/`) |
| Ray distributed compute | `src/umojaflowos_ml/ray_dist.py` | ✅ parallel generation + data-parallel hparam search, local fallback |
| A/B testing | `src/umojaflowos_ml/ab_testing.py` | ✅ deterministic champion/challenger routing, guardrail promotion |
| Drift + performance monitoring | `src/umojaflowos_ml/monitoring.py` | ✅ PSI + KS drift, degradation alerts (JSONL sink) |
| Continuous training orchestrator | `src/umojaflowos_ml/continuous.py` | ✅ extract → drift-check → retrain → register → A/B → promote |
| Neo4j graph export | `src/umojaflowos_ml/neo4j_export.py` | ✅ batched bolt loader + offline `.cypher` export (`infra/neo4j/`) |
| CPU inference service | `src/umojaflowos_ml/inference.py` | ✅ FastAPI, loads registered weights, no GPU anywhere |

## Trained weights (measured, not claimed)

Produced by `python scripts/train_all.py --workspace runtime` on the shipped
synthetic corpus (119,994 transactions / 4,000 accounts, 30-day window):

| Model | ROC-AUC | PR-AUC | Best F1 (threshold) | Notes |
|---|---:|---:|---:|---|
| FraudNet | 0.9995 | 0.9806 | 0.935 (0.98) | strong because typologies carry distinct signatures |
| CreditNet | 0.7828 | 0.5412 | 0.589 (0.57) | honest mid-strength: credit is genuinely harder |
| MuleGraphSAGE | 1.000 | 1.000 | 0.941 (0.57) | mules are structurally separable **on synthetic data** — expect degradation on real graphs |
| FraudAutoencoder | 0.9720 | 0.9051 | 0.853 (0.06) | catches 64% of held-out fraud at a 7.4% alert rate |

**Honesty note.** These metrics are on synthetic data with known typology
signatures. They prove the pipeline learns real signal end to end; they are
**not** evidence of production fraud-detection performance. Real-world
validation against labelled production cases remains a required gate before
any operational reliance — the same posture the platform applies to every
other external activation.

## Quick start

```bash
# train everything end to end (lakehouse -> train -> register -> A/B -> promote)
python scripts/train_all.py --workspace runtime

# small CI run
python scripts/train_all.py --workspace runtime --quick

# serve CPU inference against the shipped registry
python scripts/score_service.py --registry runtime/registry --port 8090

# tests
python -m pytest tests/ -q          # 16 passing
```

## Continuous training on platform data

`umojaflowos_ml.continuous.run_continuous_cycle` is the scheduler entrypoint
(cron / systemd / K8s CronJob). Each cycle: extracts the newest window
(production PostgreSQL via `extract_from_postgres` when `PG_DSN` is
configured, otherwise the synthetic generator), runs drift detection against
the previous baseline, retrains all four models, registers them as `staging`,
opens a champion/challenger A/B experiment, and promotes or rejects on the
guardrail metric. Cycle history and alerts land in `workspace/monitoring/`.

Production wiring: create a read-only reporting view
`ml_training_transactions` on the replica (columns per
`schemas.Transaction`), set `PG_DSN`, and point `MLFLOW_TRACKING_URI` at the
tracking server in `infra/mlflow/`.

## Ray

`ray_dist.parallel_generate` shards corpus generation across a Ray cluster;
`ray_dist.distributed_hparam_search` runs data-parallel hyperparameter
trials. Set `RAY_ADDRESS` for a cluster; without Ray installed both functions
run locally with identical results (used by CI).

## Neo4j

`neo4j_export.load_graph_to_neo4j` streams the gold graph snapshot with GNN
risk scores into Neo4j (`infra/neo4j/docker-compose.yaml`, GDS plugin
included). Offline/CI mode writes an idempotent `mule_graph.cypher` load
script (generated artifact: `runtime/neo4j/mule_graph.cypher`).
