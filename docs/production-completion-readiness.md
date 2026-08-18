# Production-Completion Readiness Baseline

## Measured Ledger State

The managed implementation ledger contains **125** tracked items: **58 completed** and **67 open** at the time of this baseline. That equals **46.4%** checklist completion; it is not supportable to claim 90% production completion yet.

The lower checklist percentage does not mean the implemented code is unvalidated. The canonical multi-language quality gate is green across the Go payment engine, Rust risk/compliance and ledger gateway, Python reporting/document intelligence, TypeScript control plane, shared contracts, and role tests. It does mean that many large requirements remain aggregated as open parent items and that live provider, production deployment, authorised-data, migration, and interface-validation prerequisites remain unresolved.

## Implemented, Deployment-Ready Boundaries

| Area | Evidence |
|---|---|
| Ledger split | Go and Rust double-entry validation, TigerBeetle cluster gate, confirmed-transfer projection, and reconciliation verification. |
| Event contracts | Versioned protobuf, Go Dapr publisher, Rust Dapr subscriber, and Rust `INPUT_UNAVAILABLE_EVENT_STREAM` policy gate. |
| PostgreSQL workflows | Canonical migrations; counterparty, authorisation, customer onboarding, liquidity, reporting, SAR/STR, KYC/KYB evidence, treasury recommendation, and counterparty-risk procedures. The local canonical database is migrated and exercised by four read-only integration tests. |
| Edge and identity | Disabled APISIX OIDC boundary, Keycloak realm import, deny-by-default Permify model, TLS-only Redis template. |
| Data and observability | Disabled lakehouse, OpenSearch, Sedona, GeoLibre, and open-appsec boundaries with privacy and secret-reference restrictions. |

## Remaining Work Required Before a 90% Claim

The following must be completed and evidenced before representing the platform as 90% production-complete: the full TypeScript MySQL-to-PostgreSQL cutover, executable migration of any approved non-empty business data with reconciliation, PostgreSQL wiring or fail-closed handling for every remaining console mutation, authorised-material end-to-end KYC/KYB review validation, security/accessibility/interface validation, scheduled callback deployment, and runtime provisioning of the self-hosted dependencies.

Live payments, sanctions, KYC/KYB inference, FX, regulator submission, and provider settlement must remain separately activation-gated until approved counterparties, credentials, legal approvals, reconciled balances, and production deployment evidence exist. These are not implementation placeholders; they are safety and regulatory prerequisites.

## Readiness Scoring Rule

Completion may be reported as 90% only when at least 90% of the tracked ledger is marked complete **and** the consolidated quality gate, PostgreSQL integration suite, visual/interface validation, deployment configuration validation, and required security checks pass with current evidence. Provider activation is a separate release gate and must never be inferred from code completion.
