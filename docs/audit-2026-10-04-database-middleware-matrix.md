# Database CRUD + middleware integration matrix audit (2026-10-04)

Scope: verify every frontend/backend feature is integrated with PostgreSQL
(CRUD) and the mandated middleware estate, across the TypeScript control
plane and the Go / Rust / Python services. Method: full-repo static sweep
(996 source/config files, excluding node_modules/artifacts/runtime) keyed on
each middleware, cross-checked against the 69 migrations / 147 tables and the
service directories under `services/`.

## Database layer (PostgreSQL)

- 69 migrations, **147 tables**, every table with at least one write path and
  one read path (closure proven in
  `docs/analysis-2026-10-03-feature-service-data-mapping.md`, Batch 3).
- Control plane: raw parameterized SQL via `getPool()` (`server/postgres.ts`),
  camelCase projections, immutable activity evidence on every mutation.
- Services with direct Postgres state: payment-engine (Go — durable
  settlement saga outbox, migration 0062), ledger-gateway (Rust),
  reporting-analytics + ml-intelligence + remittance-bdc + evidence-gateway
  (Python, lakehouse/bronze manifests and control-evidence outbox,
  migration 0014).

## Middleware matrix (integration point → consuming code)

| Middleware | Control plane (TS) | Go — payment-engine | Rust — ledger-gateway / risk-compliance-core | Python services | Infra |
|---|---|---|---|---|---|
| PostgreSQL | server/postgres.ts (all 275+ procedures) | settlement saga/outbox | ledger postings | reporting, ml, remittance-bdc, evidence-gateway | 69 migrations |
| TigerBeetle | ledgerReconciliation router (posting intents vs transfers) | internal/ledger + settlement | ledger-gateway postings | reporting reconciliation | staging loadtest workflow |
| Redis | onboarding/security state readers | rate-limit + idempotency | — | ml-intelligence feature cache | infra/apisix, security-stack |
| Kafka | OTel cross-service trace tests | producers/consumers via DAPR pubsub | risk-compliance-core eventing | reporting consumers | infra/dapr/components/kafka-pubsub.yaml |
| Fluvio | — | settlement outbox worker + saga | risk-compliance-core eventing.rs | — | infra/fluvio/topics.yaml |
| Temporal | OTel trace propagation | workflow orchestration refs | — | reporting-analytics jobs | chaos partition script |
| DAPR | OTel/pubsub contract tests | pubsub + subscriptions | risk-compliance-core | reporting-analytics | infra/dapr/** |
| Keycloak | auth/OIDC (45 refs, secret rotation workflows) | — | — | evidence-gateway verification | staging rotation workflows |
| Permify | governed control posture surface | internal/authorization/permify.go (+ tests) | — | reporting checks | scripts/infra/provision_permify.py |
| Mojaloop | integration registry category | payment-engine secure + gRPC staging overlays | — | — | infra/kubernetes/*mojaloop* |
| OpenSearch | — | — | — | reporting-analytics indexing | infra/opensearch roles, vector pipeline |
| open-appsec | governed control posture surface | — | — | — | scripts/infra/validate_edge_policy.py + tests |
| APISIX | security-hardening config tests | — | — | — | infra/apisix/config.yaml, security-stack compose |
| Apache Sedona | governed control posture surface | webhook geo test refs | — | reporting-analytics sedona_jurisdiction_aggregate.py + sedona_livy.py (+ route tests) | — |
| GeoLibre | governed control posture surface | — | — | reporting-analytics geolibre_project.py / geolibre_projection.py (+ test_geolibre_projection.py) | — |
| Lakehouse | lakehouseControlEvidence.ts + scheduled drain + integration test | payment-engine evidence refs | — | ml-intelligence / reporting bronze manifests | migration 0014 outbox |

## Service ↔ language ↔ middleware coverage

| Service | Language | Middleware estate |
|---|---|---|
| payment-engine | Go | Kafka, Fluvio, Temporal, DAPR, Permify, Redis, Mojaloop, TigerBeetle, Sedona(ref), Lakehouse, Postgres |
| ledger-gateway | Rust | TigerBeetle, Postgres |
| risk-compliance-core | Rust + Python | Kafka, Fluvio, DAPR |
| reporting-analytics | Python | Kafka, Temporal, DAPR, Permify, Redis, OpenSearch, TigerBeetle, Sedona, GeoLibre, Lakehouse, Postgres |
| ml-intelligence | Python | Redis, Lakehouse, Postgres |
| evidence-gateway | Python | Keycloak |
| remittance-bdc | Python | Postgres |
| document-intelligence | Python | (analysis jobs recorded via control-plane Postgres tables) |
| control-plane | TypeScript | Kafka/Temporal/DAPR (contract tests), Keycloak, Redis, APISIX, TigerBeetle, Lakehouse, Postgres |

## Findings

1. **No middleware from the mandated list is absent.** Temporal, Apache
   Sedona, and GeoLibre — the three newly named in this audit wave — all have
   real integration code (Temporal: Go workflow refs + Python jobs + chaos
   partitioning; Sedona: jurisdiction aggregation + Livy submit path with
   route tests; GeoLibre: projection modules with a dedicated test).
2. **document-intelligence** has no direct middleware client; its state is
   canonical Postgres written by the control plane (document analysis jobs,
   evidence). This is deliberate: the service is invoked, not stateful.
3. **OpenSearch and open-appsec/APISIX** are edge/observability concerns —
   integrated at infra + reporting layers, not in request-path business code.
   Their control evidence surfaces through the Governed Control Posture
   module and the `contracts` router (now with UI, see alignment audit).
4. Every middleware-facing write of business data lands in Postgres (or
   TigerBeetle for double-entry postings, mirrored into reconciliation
   tables) — see the in-memory Map audit for the persistence-classification
   sweep that backs this claim.

## Honest limits

- Static presence ≠ live connectivity: several integrations are
  disabled-by-default behind `serviceBridge.ts` env endpoints (HTTPS,
  fail-closed, contract-validated). The matrix records *wired* integration,
  and activation remains a verified health-check event, by design.
