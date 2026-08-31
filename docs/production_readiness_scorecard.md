# UmojaFlowOS Production-Readiness Scorecard
**Assessment date:** 2026-08-31
**Scope:** Local PostgreSQL, Redis, service test suites, synthetic Nigerian/CBN staging data, resilience tests, coverage, security controls, and application-level RBAC.
> This is an engineering readiness assessment. Synthetic data, local tests, and coverage results do not constitute CBN authorization, live-provider approval, legal evidence, or permission to activate customer payments.
## Executive decision
UmojaFlowOS is at **Technical GO for the tested local and database-backed paths**, with explicit engineering gates still open. Redis event-ledger tests now execute successfully, PostgreSQL schema-owner separation is verified, 125 insertable database tables have been populated with deterministic synthetic Nigerian/CBN scenarios, the Toxiproxy partition scenario has passed, and the clean-room compliance/RBAC suite passes 44 of 44 targeted tests.
The platform remains **Regulatory NO-GO for live activation**. Real legal/entity/UBO evidence, provider contracts and permissions, HSM and mTLS ceremonies, live CBN sandbox authorization, external supervisory integrations, independent approvals, and controlled-pilot evidence remain mandatory.
## Service scorecard
| Service | Current evidence | Score | Disposition | Open gate |
|---|---|---:|---|---|
| Payment engine | Go race tests, real PostgreSQL UNKNOWN-store tests, Toxiproxy partition pass, Redis/TLS webhook tests, 58.9% full statement coverage, 73.8% multirail integration coverage | 7.4/10 | Conditional technical GO | Raise critical SQL/provider/HSM runtime coverage and repeat multi-replica load tests in staging. |
| Risk-compliance core | Rust 1.89.0, all-feature tests, 82.51% line coverage, 78.53% function coverage | 8.4/10 | Technical GO with follow-up | Add provider transport and eventing failure combinations to raise function coverage. |
| Ledger gateway | Rust 1.89.0, all-feature tests, 87.55% line and 80.36% function coverage | 9.0/10 | Technical GO | Execute live TigerBeetle reconciliation, DR, and rollback evidence. |
| Document intelligence | PaddleOCR and Docling installed, 43 tests, 86% branch-aware coverage, Ollama failure paths covered | 9.0/10 | Technical GO | Validate production model provenance, mTLS, resource limits, and data-protection controls. |
| Reporting analytics | Strict warnings pass; 90 tests pass, including two real Redis ledger tests | 9.0/10 | Technical GO | Repeat against managed Redis/streaming infrastructure and capture persistence/recovery evidence. |
| Control plane | Clean-room targeted RBAC/compliance suite: 44/44 passed; broad full suite has explicit external skips | 8.2/10 | Conditional technical GO | Execute remaining external/live integrations and resolve full-suite open-handle behavior. |
**Evidence-weighted technical readiness score: 8.5/10.** This is not a regulatory score.
## Verified local evidence
| Control | Result | Meaning |
|---|---|---|
| Redis event ledger | 2/2 previously skipped tests passed against Redis 7.0.15 database 15 | Atomic duplicate handling and hashed untrusted event IDs execute against real Redis. |
| PostgreSQL migration identity | Passed | Migrations use `assurance_schema_owner`; application queries use `umoja_app`; both target `umoja_test` or the clean-room equivalent. |
| Application DDL boundary | Passed | `umoja_app`: schema `USAGE=true`, schema `CREATE=false`, database `CONNECT=true`, database `CREATE=false`, zero owned objects, no default privileges. |
| Synthetic platform seed | Passed | 125 insertable tables, three deterministic records per table, local-staging environment only. |
| Seed integrity | Passed | Zero orphan payment/trade records, invalid market observations, invalid AML subject counts, unauthorized execution assertions, or premature regulatory submissions. |
| Multirail durability | Passed | Duplicate terminal decisions, stale leases, payload binding, concurrent claims, and Toxiproxy partition behavior. |
| Clean-room compliance/RBAC | Passed | 44/44 targeted tests across counterparty onboarding, credential RBAC, service contracts, role matrix, SoD, KYC visibility, sandbox boundaries, and migration controls. |
| Reporting warning hygiene | Passed | `pytest -W error` passes with no socket/resource-leak or deprecation failures. |
## Production practices implemented
### Security
The platform implements non-root restricted Kubernetes deployment profiles, read-only root filesystems, secret-volume injection for mTLS and signer material, fail-closed provider routing, payload SHA-256 binding, immutable evidence decisions, short-lived authorization controls, PostgreSQL role separation, and no-DDL application grants. The seeder refuses `production`, `prod`, and `live` environments and labels generated records as synthetic.
Redis local testing uses loopback binding, protected mode, a disposable isolated database, no persistence, and no operational data. Production Redis must use TLS, ACLs, secret-managed credentials, network policy, bounded connection/read timeouts, and retention-compatible persistence.
### Performance and resilience
The coordinator baseline is approximately 1.25–1.37 million same-key operations per second and 0.27–0.30 million distinct-key operations per second on the sandbox host. These values are not production capacity commitments. Production performance must be measured with PostgreSQL, provider latency, HSM latency, ledger writes, resource limits, replica count, and rate limits enabled.
Implemented resilience controls include PostgreSQL atomic claims and partial unique indexes, advisory-locked migrations, bounded signer retries, durable UNKNOWN reconciliation, payload binding, Toxiproxy partition testing, and Redis duplicate-event protection. Production tuning should use measured pool sizing, statement/transaction timeouts, lock-wait recording rules, queue-depth SLOs, provider-specific circuit breakers, and load tests at intended pilot limits.
### Data and test integrity
The seed verifier now checks actual row counts for every manifest table rather than trusting planned row counts. The synthetic generator handles ledger foreign keys, distinct debit/credit accounts, CBN disclosure/complaint constraints, stakeholder assignment target exclusivity, and stablecoin review roles. The reporting event-consumer tests reset global ledger state around each boundary test to prevent order-dependent false results.
## Feature, business-rule, and logic completeness
| Feature domain | Accuracy/completeness assessment | Score | Readiness |
|---|---|---:|---|
| Multi-rail payments | Idempotency, payload binding, UNKNOWN state, lease loss, fail-closed fallback, reconciliation, and duplicate terminal decision rules are implemented and exercised. | 8.8/10 | Strong technical readiness; live provider and HSM evidence pending. |
| Stablecoin orchestration | Route reviews, issuer evidence, compliance gates, treasury buffers, and decision roles are modeled and validated. | 7.9/10 | Conditional; issuer licensing, contracts, reserves, and operational evidence pending. |
| AML/CFT/CPF | Screening, sanctions/high-risk cases, SAR/STR records, SoD, and escalation structures are present. | 7.9/10 | Conditional; real data feeds, MLRO operation, model validation, and independent assurance pending. |
| KYC/document intelligence | Upload controls, evidence, model selection, provenance, PaddleOCR/Docling, Ollama policy, and strict failure handling are implemented. | 8.7/10 | Strong technical readiness; production model governance and privacy/legal evidence pending. |
| Counterparty onboarding | Legal, technical, compliance, treasury, evidence, recertification, and role isolation paths are tested. | 8.7/10 | Strong technical readiness; real counterparties and approvals pending. |
| CBN sandbox/reporting | Dossiers, test plans, incidents, reporting packs, deadlines, evidence, and submission guards exist. | 7.3/10 | Conditional; authorized CBN interfaces, real records, and submission approval pending. |
| Treasury/ledger reconciliation | TigerBeetle facts, posting intents, reconciliation runs, discrepancies, buffers, and recommendations are represented. | 8.1/10 | Conditional; live bank/TigerBeetle reconciliation and DR evidence pending. |
| Observability/incident response | Prometheus metrics, alerts, Grafana dashboards, runbooks, evidence capture, and chaos scenarios exist. | 8.1/10 | Conditional; live alert delivery, SLOs, and response drills pending. |
| Governance/RBAC | Database role separation, application permission matrices, dual-control structures, and independent approvals are modeled. | 8.8/10 | Strong technical readiness; verified human identities and signed approvals pending. |
**Business-rule weighted score: 8.2/10.** The lower scores reflect production evidence and governance dependencies, not an assertion that the underlying code is incorrect.
## Remaining release gates
| Priority | Gate | Required evidence |
|---|---|---|
| P0 | Legal/entity/UBO identity | Verified corporate records, UBO chain, accountable officers, conflicts/recusals, counsel review, and board approval. |
| P0 | Controlled live perimeter | Written pilot scope, customer eligibility, transaction/exposure caps, provider permissions, rollback authority, and CBN authorization. |
| P0 | Financial integrity | Live PostgreSQL/TigerBeetle reconciliation, zero unexplained discrepancies, and independently reviewed rollback evidence. |
| P1 | Provider and signer operations | Contracts, mTLS certificates, HSM key ceremonies, rotation/revocation evidence, provider contacts, and failover drills. |
| P1 | Observability/SLO | Live Prometheus scraping, Alertmanager routing, PagerDuty/Slack delivery, dashboard review, and alert-response drill. |
| P1 | Coverage/performance | Go critical-path coverage, Rust function follow-up, multi-replica load, latency budgets, pool/lock measurements, and resource-limit tests. |
| P1 | External integrations | Live Redis, Keycloak/Vault, OpenSearch/WORM, TigerBeetle, bank/PSP, Mojaloop, and CBN supervisory-feed tests. |
## Final disposition
**Technical readiness: 8.5/10.**
**Business-rule and feature completeness: 8.2/10.**
**Regulatory/live activation: NO-GO pending authorized evidence.**
The next best engineering step is a controlled staging run with all external dependencies enabled, followed by targeted Go SQL/runtime coverage and capacity testing. The next governance step is replacing only the synthetic records that authorized Legal, Compliance, and CBN processes approve for use in the actual submission dossier.
## References
[1]: https://sandbox.cbn.gov.ng/ "CBN Regulatory Sandbox"
[2]: https://redis.io/docs/latest/operate/oss_and_stack/management/security/ "Redis security documentation"
[3]: https://www.postgresql.org/docs/current/ddl-priv.html "PostgreSQL privileges documentation"
[4]: https://llvm.org/docs/CommandGuide/llvm-cov.html "LLVM coverage documentation"
[5]: https://github.com/Shopify/toxiproxy "Toxiproxy project"
