# Database & Middleware Integration Matrix — 2026-10-04

Branch: `audit-remittance-bdc-antiwipe-performance-2026-09-24`

## Postgres layer

69 migrations, 147 tables. Every frontend tRPC procedure ultimately resolves to a Postgres read/write (184 postgres router procedures) or a service call whose writes land in Postgres/TigerBeetle. CRUD coverage verified per router in `audit-2026-10-04-frontend-backend-alignment.md`.

## Middleware matrix

| Middleware | TS (control-plane) | Go (payment-engine) | Rust (ledger-gateway) | Python services | Infra |
|---|---|---|---|---|---|
| Postgres | pool + 184 procs | fencestore, replay DDL | stores | all services | 69 migrations |
| Redis | cache/queues | TLS replay store | — | rate limits | TLS enabled |
| Kafka | producers/consumers | consumer groups | — | consumers | — |
| Fluvio | streaming bridge | — | streaming | — | — |
| Temporal | workflow clients | workers | — | workers | — |
| Dapr | sidecar bindings | pub/sub | — | bindings | components |
| Keycloak | OIDC auth | token verify | — | token verify | realm config |
| Permify | authorization checks | — | — | checks | schema |
| Mojaloop | adapter routes | ALS/quotes | — | — | — |
| TigerBeetle | ledger client | — | ledger client | — | cluster |
| OpenSearch | search proxy | — | — | indexing | dashboards |
| open-appsec | — | — | — | — | edge WAF |
| APISIX | upstream API | upstream | upstream | upstream | gateway routes |
| Apache Sedona | — | — | — | geospatial jobs | — |
| GeoLibre | — | — | — | geospatial lib | — |
| lakehouse | — | — | — | reporting-analytics | — |

## Service ↔ language ↔ middleware

| Service | Language | Middleware used |
|---|---|---|
| control-plane | TypeScript | Postgres, Redis, Kafka, Fluvio, Temporal, Dapr, Keycloak, Permify, Mojaloop, TigerBeetle, OpenSearch, APISIX upstream |
| payment-engine | Go | Postgres, Redis, Kafka, Temporal, Dapr, Keycloak, Mojaloop, APISIX upstream |
| ledger-gateway | Rust | Postgres, TigerBeetle, Kafka/Fluvio streaming |
| risk-compliance-core | Rust + Python | Postgres, Redis, Kafka, Temporal |
| reporting-analytics | Python | Postgres, OpenSearch, Sedona, GeoLibre, lakehouse |
| ml-intelligence | Python | Postgres, Redis, Kafka, Temporal |
| evidence-gateway | Python | Postgres, OpenSearch, Dapr |
| remittance-bdc | Python | Postgres, Redis, Mojaloop |
| document-intelligence | Python | Postgres, Dapr (stateless by design) |

## Findings

1. Temporal, Apache Sedona, and GeoLibre all have real integration code — not stubs.
2. document-intelligence is intentionally stateless; it writes results via Postgres, no session state held.
3. OpenSearch, open-appsec, and APISIX are edge/observability-layer middleware; services integrate through the gateway/proxy, not direct clients — this is by design.
4. Every business write lands in Postgres or TigerBeetle; no business state lives only in memory (see `audit-2026-10-04-inmemory-map-audit.md` for the two multirail stores fixed in this wave).

## Honest limits

- The `serviceBridge` between control-plane and some Python services is disabled by default in non-production envs; enable per deployment docs.
- APISIX/open-appsec integration is config-level (gateway routes/WAF policy), verified by config presence, not runtime traffic replay in this audit.
