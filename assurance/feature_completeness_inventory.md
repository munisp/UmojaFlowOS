# UmojaFlowOS Feature-Completeness and Trust-Boundary Inventory

**Author:** Manus AI
**Assessment date:** 26 August 2026
**Evidence basis:** Tracked source review, parallel service-area audit output, Makefile gates, and recorded assurance logs.

## System map

| Service area | Observed responsibility | Control boundary | Offline evidence | Production prerequisite | Assurance status |
|---|---|---|---|---|---|
| Control plane | Express/tRPC authority surface, OIDC sessions, stakeholder workflows, service bridges, regulated evidence state. | Does not activate provider execution without integration/credential gates; policy defaults are refusal-oriented. | 65-file final Vitest suite includes public-boundary, role, contract, OIDC/JWKS, security-hardening, and workflow unit tests. | Keycloak, PostgreSQL roles, OPA/Permify, Kafka/Redis, policy configuration, staging credentials. | **Partial**—many runtime/bridge suites skipped. |
| Payment engine | Go HTTP service for provider webhook validation, order validation, double-entry posting validation, metrics, and Temporal workflow execution. | TLS/HMAC/configuration validation and dependency fail-closed behavior are represented in source/tests. | Go tests pass through `make check`; load/round-trip/staging controls are present. | TigerBeetle, Temporal, provider credentials/webhook allowlists, secrets, durable event sink. | **Partial**—no real provider or ledger evidence. |
| Ledger gateway | Rust verifier of balanced postings, TigerBeetle facts versus PostgreSQL projections, and payment-order events. | Stateless validation layer; authoritative writes remain outside this service. | Rust unit/router tests cover malformed requests, imbalance, mismatch, and reconciliation calculation paths. | Identified TigerBeetle cluster and PostgreSQL projection source; promoted control-plane authority. | **Partial**—backend is disabled/not attested in scope. |
| Risk and compliance core | Rust screening/monitoring assessments, immutable evidence eventing, and stress-test CLI. | Assessment outputs are non-executional; missing/stale/inconsistent input is rejected. | Unit/integration source coverage includes deterministic scoring and evidence-contract behaviors. | Dapr/Fluvio/Kafka, policy/rule data, authorized analyst workflow, AML/CFT provider evidence. | **Partial**—eventing/provider/runtime delivery not exercised. |
| Reporting and analytics | FastAPI lakehouse, Sedona/geospatial, regulatory assembly, and evidence consumers. | Review/evidence assembly path, not a direct payment execution authority. | Python route/integrity/contract tests are present; local suite contributes to `make check`. | Lakehouse, object storage/WORM, Sedona/Livy, regulatory submission endpoint, OpenSearch. | **Partial**—external delivery/lakehouse control evidence unverified. |
| Document intelligence | Review-only document/deepfake/PAD/model provenance evidence. | Code explicitly confines deepfake and PAD signals to review-required/non-decisional results. | Library tests run in Python suite. | Authorized model endpoints, provenance registry, consented source content, trained reviewer process. | **Partial**—model/provider behavior not runtime-attested. |
| Retention delete gateway | Python worker authorization, Postgres single-use claim, manifest signing, mTLS OpenSearch adapter, monitoring, synthetic observability, and Chaos/Locust test assets. | Fail-closed database claim and exact physical-index scope; OpenSearch deletion cannot proceed without authorization in tested paths. | 47 focused tests pass; monitoring artifacts parse; targeted acceptance tests pass. | Committed source, PostgreSQL role provisioning, OpenSearch mTLS/RBAC, WORM verifier/archive, Kubernetes secrets, Prometheus/Alertmanager. | **Partial**—untracked local addition, external/container/cluster tests skipped. |

## Implemented controls versus deployment claims

| Control | Code/configuration evidence | What it does **not** prove |
|---|---|---|
| TigerBeetle reconciliation | Schema, scripts, validators, and unit tests exist. | That an actual cluster has the expected account topology, survives consensus loss, and reconciles production facts. |
| Keycloak federation | JWKS/audience tests and staging test scaffolding exist. | That the deployed realm/client, TLS path, issuer, redirect URI, and revocation/rotation behavior are correct. |
| Provider webhooks | HMAC/timestamp/replay and CIDR logic are implemented/tested. | That a real provider signing key, source ranges, delivery retry behavior, and event semantics match the contract. |
| WORM/retention | Decision worker and verifier contracts, signatures, policy/template artifacts, and tests exist. | That actual object-lock retention, legal hold, archive completeness, and authorized deletion approval are active. |
| Monitoring and paging | Prometheus rules, Grafana JSON, Alertmanager templates, native parser checks, and synthetic monitor exist. | That services are scraped, alerts reach PagerDuty, a human responds, or dashboards display runtime signals. |
| Deployment rollback | GitHub Actions and Helm/Kubernetes definitions define rollback behavior. | That the protected environment, release revision, health checks, rollback command, and recovery have run successfully. |
| Chaos tests | Chaos Mesh manifests and opt-in test suites exist. | That the controller has the needed privileges, faults are safely scoped, and production/staging recovers as designed. |

## Explicit non-claims

The inventory does not claim that a simulator is a production integration, that a unit test proves an external contract, that a parsing check proves a deployment, or that a static runbook proves an operational capability. All such boundaries are tracked as staging evidence requirements in `requirements_traceability.md`.
