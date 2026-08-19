# Production-Completion Readiness Baseline

## 2026-08-19 revision

This section supersedes the measured state recorded below it. The earlier text is retained, because a readiness baseline that quietly rewrites its own history is not a baseline.

The managed implementation ledger now contains **148** tracked items: **144 completed** and **4 open**, which is **97.3%** checklist completion. That number measures the ledger, not production readiness, and the two should not be conflated. All four remaining items are externally blocked and cannot be closed in any environment without input this project does not have: real provider adapters awaiting approved credentials and licensed counterparties, retirement of transitional MySQL/TiDB access awaiting an executed production cutover, and two Ollama evidence-only validations blocked by host memory.

Measured quality gates at this revision: the managed suite passes 361 tests, with 23 opt-in live cross-language regressions available; Go 19; Rust 46 across the risk core and ledger gateway; Python 39. `make check` is green across all four languages. The canonical database holds 35 validated tables and is verified empty of regression fixtures after each full run.

### What would move this from checklist completion to production readiness

Four things, none of which are code. An approved production PostgreSQL deployment with the cutover executed and reconciled against a non-empty real source. Credential-verified provider connections for payment, FX, screening, and regulatory submission, each with a licensed counterparty confirmed. A host capable of running the 8B evidence models, so the KYC/KYB inference path can be validated end to end. Deployment of the middleware whose activation contracts are written and validated but deliberately disabled.

Until those exist, the honest description is that the provider-independent platform is implemented and verified, and every provider-dependent path is gated closed rather than stubbed open.

### The four blocked items are prepared, not merely deferred

Each remaining item now carries the work that *can* be done without the missing input, so that when the input arrives the remaining step is small and its preconditions are already enforced.

| Blocked item | Preparation in place |
| --- | --- |
| Real provider adapters | `server/providerActivationGate.test.ts` proves no code path sets an integration `active`, that the lifecycle still offers `credential_pending` and `verification_pending`, that the live schema stores only a `secret_reference` with no credential-shaped column, that the bridge cannot fall back to an implicit endpoint, and that contracts refuse execution authority. Verified by introducing an activation statement, which fails the check. |
| Transitional MySQL/TiDB retirement | `server/transitionalRetirementReadiness.test.ts` enumerates the exact surface awaiting deletion as a closed set with a recorded reason per file, and asserts the nine canonical modules stay free of it so retirement remains a deletion rather than a refactor. |
| Ollama evidence-only validation | The host ceiling is measured rather than assumed: a graduated probe shows models up to 986 MB load and answer while 1.9 GB and above are killed, so inference works and only weight size blocks it. |
| Ollama request validator execution | The validator and its assertions are implemented and committed; only execution is blocked, on the same measured ceiling. |

## Measured Ledger State

> Superseded by the 2026-08-19 revision above; retained as the historical record.

The managed implementation ledger contains **125** tracked items: **58 completed** and **67 open**. That equals **46.4%** checklist completion. It is therefore not supportable to claim 90% production completion.

The canonical multi-language quality gate is green across the Go payment engine, Rust risk/compliance and ledger gateway, Python reporting/document intelligence, TypeScript control plane, shared contracts, and role tests. The local canonical PostgreSQL database has all migrations applied and its four read-only integration tests pass. This confirms an implemented and validated foundation, not production activation.

## Implemented, Deployment-Ready Boundaries

| Area | Evidence |
|---|---|
| Ledger split | Go and Rust double-entry validation, TigerBeetle cluster gate, confirmed-transfer projection, and reconciliation verification. |
| Event contracts | Versioned contracts, Go Dapr publisher, Rust Dapr subscriber, TypeScript parsers, and fail-closed Rust `INPUT_UNAVAILABLE_EVENT_STREAM` handling. |
| PostgreSQL workflows | Canonical migrations; counterparty, authorisation, customer onboarding, liquidity, reporting, SAR/STR, KYC/KYB evidence, treasury recommendation, and counterparty-risk procedures. |
| Edge and identity | Disabled APISIX OIDC boundary, Keycloak realm import, deny-by-default Permify model, and TLS-only Redis template. |
| Data and observability | Disabled lakehouse, OpenSearch, Sedona, GeoLibre, and open-appsec boundaries with privacy and secret-reference restrictions. |

## Remaining Work Before a 90% Claim

The remaining evidence includes the full TypeScript MySQL-to-PostgreSQL cutover, approved non-empty business-data migration and reconciliation, PostgreSQL wiring or fail-closed handling for every remaining console mutation, authorised-material KYC/KYB end-to-end validation, security/accessibility/interface validation, scheduled callback deployment, and runtime provisioning of self-hosted dependencies.

Live payments, sanctions, KYC/KYB inference, FX, regulator submission, and provider settlement remain activation-gated until approved counterparties, credentials, legal approvals, reconciled balances, and deployment evidence exist. These are safety and regulatory prerequisites, not implementation placeholders.

## Readiness Scoring Rule

Completion may be reported as 90% only when at least 90% of tracked ledger items are complete and the consolidated quality gate, PostgreSQL integration suite, visual/interface validation, deployment configuration validation, and required security checks pass with current evidence. Provider activation is a separate release gate and must never be inferred from code completion.
