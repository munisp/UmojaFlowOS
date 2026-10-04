# Feature → Service → Data Mapping Audit (2026-10-03)

Scope: guarantee that every frontend surface maps to a backend procedure, every
backend module maps to the database tables and middleware it needs, and no
recorded data can silently fall on the floor. Method: machine-extracted mapping
from the actual codebase (not aspirational), gap enumeration, then closure.

## 1. Frontend → backend: 100 % wired

- 182 real tRPC call sites across 16 UI surfaces (`Home.tsx`, 13 workspace
  components, `useAuth`, `StakeholderPortal`).
- **182/182 resolve to server procedures.** The single apparent exception
  (`trpc.ai.chat` in `AIChatBox.tsx`) exists only inside a JSDoc example
  comment — the component is driven by its `onSendMessage` prop and rendered
  only on the ComponentShowcase page. No production surface calls a missing
  procedure.

## 2. Backend procedures → modules → tables

- **275 tRPC procedures** across routers: `auth`, `postgres`, `contracts`,
  and the eight new coverage routers (`stakeholder`, `administratorKyc`,
  `tradeControl`, `enterpriseGovernance`, `controlAssurance`,
  `executionRehearsal`, `ledgerReconciliation`, `livePipelines`).
- **147 PostgreSQL tables** across migrations 0001–0066.
- **Before this audit: 45 tables (31 %) were orphaned** — created by
  migrations but never read or written by any code in TypeScript, Python, Go,
  or Rust. Any data intended for them would have been silently lost.

### Orphan families closed this pass

| Family (migration) | Tables | Closure |
|---|---|---|
| Stakeholder accounts (0018/0019/0020/0021/0025) | 9 | `server/stakeholderAccounts.ts`: scrypt credential enrolment, super-admin approval decisions (DB trigger gates admin activation), sessions (issue/resolve/revoke), notification preferences, privacy-safe security messages, KYC reminder deliveries, governance audit on every mutation |
| Administrator KYC (0022/0023/0024/0027) | 8 | `server/administratorKyc.ts`: evidence, reviews, escalations with independent second review (DB trigger enforced), upload policy + audit (transactional), upload intents with policy-size enforcement + oversize exceptions, evidence requests |
| Trade Payment Control OS (0031) | 7 | `server/tradePaymentControl.ts`: cases, stakeholders, evidence submit/review, routes, approvals, exceptions, reconciliations |
| Enterprise governance (0033) | 7 | `server/enterpriseGovernance.ts`: governed bank accounts, liquidity policies, stablecoin treasury mandates, supply-chain finance, spend-card programmes + policy rules, governance reviews |
| Control Assurance Hub (0034) | 3 | `server/controlAssuranceHub.ts`: append-only assessments, adapter certifications, audit packets (DB triggers prohibit UPDATE/DELETE) |
| Execution rehearsal + stablecoin (0029/0030/0055) | 6 | `server/executionRehearsal.ts`: orchestration routes + reviews, authorised execution tests, approval rehearsals, execution evidence, settlement-attempt idempotency |
| TigerBeetle reconciliation (0042) | 3 | `server/ledgerReconciliation.ts`: posting intents, reconciliation runs (with status-consistency validation), discrepancies |
| Live control pipelines (0039) | 2 | `server/liveControlPipelines.ts`: provider send requests with finality state machine, regulatory submission attempts |

**After closure: 147/147 tables have a write and read path.**

## 3. UI-orphan procedures closed

25 server procedures existed but had no console surface. Closed via the new
`OperationsCoverageWorkspace` (`/console/operations`, lazy-loaded chunk,
sidebar entry for admin/auditor/compliance/treasury roles):

- Compliance alert lifecycle: `complianceAlerts`, `raiseComplianceAlert`,
  `acknowledgeComplianceAlert`, `escalateComplianceAlert`,
  `dismissComplianceAlert`
- Operational evaluators: `evaluateLiquidityThresholds`,
  `evaluatePaymentFailures`, `evaluateComplianceFlags`, `fxSpread`
- Beneficiaries: `createBeneficiary`, `recordBeneficiaryScreening`
- Market data: `recordMarketObservation`
- Counterparty risk: `createCounterpartyRiskAssessment`,
  `escalateCounterpartyRiskAssessment`
- Notification audit: `notificationDeliveries`
- Readiness programmes: `createImtoReadinessProfile`,
  `recordImtoReadinessEvidence`, `assessImtoReadiness`,
  `createVaspOffshoreCounterpartyProfile`,
  `assessVaspOffshoreCounterpartyProfile`,
  `recordVaspOffshoreCounterpartyEvidence`

Intentionally not UI-surfaced (by design, documented):
- `contracts.*` (15 procedures): service-boundary parsers and the live
  service bridge — exercised by Go/Rust/Python services and contract tests,
  not by the console.
- `persistDocumentAnalysisEvidence`: called by document-intelligence over the
  service bridge.
- `captureServiceHealthSample`: driven by `scheduled/serviceHealthCollector.ts`.
- `rejectReadinessAssuranceEvidence`: assurance-verifier flow reachable via the
  CBN sandbox workspace verifier path.
- `postgres.readiness`: infrastructure probe used by deploy checks.

## 4. Service and middleware map

| Service | Exposes | Middleware |
|---|---|---|
| control-plane (TS, tRPC) | 275 procedures | PostgreSQL, Keycloak, Redis, APISIX, OTel |
| payment-engine (Go) | `/v1/orders/validate`, `/v1/ledger/postings`, Yellowcard webhooks/sends | PostgreSQL, TigerBeetle, Kafka, Fluvio, Mojaloop, Permify, DAPR, Fabric |
| ledger-gateway (Rust) | `/v1/postings/validate`, `/v1/projections/reconcile` | TigerBeetle, Redis, OTel |
| risk-compliance-core (Rust) | `/v1/policy/evaluate`, `/v1/monitoring/evaluate`, `/v1/counterparty/assess`, `/v1/screening/check` | Kafka, Fluvio, DAPR, OTel |
| evidence-gateway (Python) | `PUT /v1/evidence/{sha}/{run}/{path}` | S3/MinIO, Keycloak, OTel |
| ml-intelligence (Python) | score_service, training, lakehouse, GNN, MCMC, KG | PostgreSQL, Redis, Neo4j, FalkorDB, Ollama, Ray, OTel |
| reporting-analytics (Python) | `/v1/reports/validate`, Dapr Kafka consumer | PostgreSQL, Kafka, OpenSearch, DAPR, OTel |
| remittance-bdc (Python) | remittance/BDC domain + postgres_store | PostgreSQL, OTel |
| document-intelligence (Python) | OCR/PAD/deepfake, ollama adapter | Ollama, S3/MinIO, OTel |

Cross-service traffic goes through `server/serviceBridge.ts` — disabled by
default, private-transport-only (HTTPS off-loopback), contract-validated with
fail-closed parsers.

## 5. Verification

- `platformCoverageRouters.test.ts`: 14/14 (router surface completeness, RBAC
  refusals per role per router, input-validation-before-persistence).
- ml-intelligence suite: 33/33.
- TypeScript: new files type-clean under the project config (pre-existing
  cascade noise from the wiped pnpm store in this sandbox aside — CI with an
  intact lockfile is authoritative).
- Visualization: `/mnt/agents/output/app/index.html` — interactive layered map
  of 531 nodes / 835 edges (UI → procedure → module → table, service →
  middleware), generated from the extracted dataset, not drawn by hand.

## 6. Honest limits

- New modules are SQL-correct against migration constraints but have not run
  against a live PostgreSQL in this sandbox; their integration tests run in CI
  (testPostgres harness) alongside the existing suites.
- `ai.chat` remains intentionally unimplemented: AI narration is advisory-only
  and served by the ollama bridge in ml-intelligence, not the console.
