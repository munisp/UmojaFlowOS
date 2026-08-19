# Production-Completion Readiness Baseline

## 2026-08-19 revision (documented provider adapter boundaries)

This revision supersedes the summary below while retaining it as audit history. The implementation ledger now contains **204** items: **198 completed** and **6 externally blocked**, or **97.1%** checklist completion. The six remaining items are external facts: licensed provider credentials/counterparty confirmation; an approved production cutover; two Ollama evidence-only executions on a suitable visual-model host; provisioned production middleware; and refreshed secured-development Kafka and Permify identities.

First-party API documentation was reviewed for Paystack, Flutterwave, Safaricom M-PESA Daraja, Onafriq, Thunes, and Kotani Pay; the source record is retained in `docs/provider-api-research-notes.md`. The implementation selects only two narrow documented protocol boundaries. The Go **Paystack** client supports a credentialed, HTTPS-only read of the documented transaction-verification resource for provider-reported NGN, KES, or ZAR records and verifies the documented HMAC-SHA512 webhook signature. It contains no collection, beneficiary, transfer, payout, or settlement operation. The Go **Safaricom Daraja** client supports only the documented OAuth client-credential request for Kenya (KES) credential validation. It contains no STK, C2B, B2B, B2C, callback, reversal, or settlement operation.

Both clients default to disabled forms, require secrets only through trusted runtime composition, reject remote plaintext transport, permit loopback HTTP only in explicit tests, constrain response parsing, and do not alter the payment-engine’s disabled provider-execution state. A successful response is a provider-reported protocol fact, not proof of a licensed relationship, account enablement, corridor availability, payment execution, settlement, or CBN approval. The canonical `make check` passed contracts, infrastructure, Go, Rust, Python, and TypeScript; the full canonical TypeScript suite passed **573** tests with **153** activation-gated skips.

## 2026-08-19 revision (CBN Regulatory Sandbox Cohort 2 readiness)

This revision supersedes the summary below while retaining it as audit history. The implementation ledger now contains **201** items: **195 completed** and **6 externally blocked**, or **97.0%** checklist completion. The remaining six items are unchanged external facts: licensed provider credentials/counterparty confirmation; an approved production cutover; two Ollama evidence-only executions on a suitable visual-model host; provisioned production middleware; and refreshed secured-development Kafka and Permify identities.

The official CBN Regulatory Sandbox Cohort 2 page was reviewed and its applicable requirements are retained in `docs/cbn-cohort-2-source-notes.md`. UmojaFlowOS is aligned to the VASP-track controlled-testing objective for Nigeria (NGN), especially its USDC/USDT-only scope, fail-closed provider activation, evidence-only stablecoin boundary, human-reviewed KYC/KYB, audit trail, and non-assertive reporting. The full requirement mapping, including material gaps and the official framework-PDF bot-verification limitation, is retained in `docs/cbn-cohort-2-platform-gap-assessment.md`.

Migrations `0015_cbn_sandbox_readiness.sql` and `0016_cbn_sandbox_evidence_assessments.sql` increase the canonical PostgreSQL schema to **46** tables. They create CBN Cohort 2 readiness dossiers, SHA-256/HTTPS evidence records, documented controlled-test plans, consumer disclosure/complaint records, material incidents, reporting packs, and immutable dossier-evidence assessments. Role-enforced control-plane APIs prohibit this module from claiming external submission, CBN admission, licence, provider activation, payment execution, settlement, regulatory eligibility, or an external reporting/incident notification. An assessment compares only required, recorded, and missing evidence categories plus a stored test-plan record; it records reviewer rationale and mechanically fixes every external-authority flag to false. A test plan records the permitted use, user category, transaction and aggregate-exposure ceilings, time window, success metrics, and orderly-wind-down evidence, but remains explicitly non-executable pending authorised external test parameters. The `/sandbox` console destination now presents these recorded controls to the permitted roles with visible non-licensing and non-submission language.

Closing validation ran 15 focused source, live PostgreSQL, and schema-baseline tests. The canonical `make check` passed contracts, infrastructure, Go, Rust, Python, TypeScript, and the managed application. After the console addition, the complete canonical TypeScript suite passed **573** tests with **153** activation-gated skips; the CBN workspace was also visually verified. The local CBN sandbox records were verified empty after regression cleanup. Canonical GitHub commits: `eeda13a`, `f85a594`.

## 2026-08-19 revision (canonical control-evidence outbox and governed evidence completion)

This revision supersedes the summary below while retaining it as audit history. The implementation ledger now contains **194** items: **188 completed** and **6 externally blocked**, or **96.9%** checklist completion. The six items are unchanged external gates: licensed provider credentials and counterparty confirmation; an approved production cutover; two Ollama evidence-only executions on a host that can load a suitable visual model; provisioned production middleware; and refreshed secured-development Kafka and Permify identities.

The canonical PostgreSQL schema now has **39** validated tables following migration `0014_control_evidence_outbox.sql`. The migration adds an append-only, application-role write-protected `control_evidence_outbox`; PostgreSQL triggers insert a redacted SHA-256 correlation, lifecycle stage/gate/cycle facts, observation time, and the explicit statement `authoritative: false` in the same transaction as onboarding lifecycle and gate-decision records. No customer, account, document, credential, wallet, provider identifier, or execution authority is copied into the outbox.

The scheduled dispatcher is intentionally constrained. It is cron-only and does nothing unless a catalog endpoint and the dedicated PostgreSQL-control source token are both explicitly configured. For pending outbox rows it acquires a row lock, sends a source-bound catalog event, records a success as delivered only after a 2xx response, and records a bounded failure attempt without changing a canonical control decision. It therefore supports governed analytics evidence, not workflow authority, payment execution, provider activation, regulatory submission, or settlement. Three PostgreSQL/real-HTTP regressions prove its disabled, exactly-once, and bounded-failure behaviours.

The active provider-independent evidence paths are now complete: the Go payment engine and Rust risk core arrive through Dapr; Go Temporal workflow and Permify outcomes are emitted only after their decisive operation; Python reconciled USDC/USDT exposure observations are opt-in and redacted for Nigeria (NGN), Kenya (KES), and South Africa (ZAR); and canonical onboarding evidence arrives via the PostgreSQL outbox. TigerBeetle, AI/ML inference, and provider-lifecycle evidence are correctly absent until their runtime/provider gates are satisfied, rather than being simulated.

Closing validation for this revision ran the managed suite with PostgreSQL and all live Go/Rust/Python/ledger/service regressions enabled: **84 files and 561 tests passed**. The canonical `make check` passed its contracts, infrastructure, Go, Rust, Python, and TypeScript stages after synchronization. Canonical fixture cleanup was re-run and the database baseline was confirmed clean after the test run.

## 2026-08-19 revision (attached lifecycle operating model, governed analytics, and stablecoin boundary)

This revision supersedes the summary below while retaining it as an audit history. The ledger now records **182** items: **176 completed** and **6 externally blocked**, or **96.7%** checklist completion. The six open items are all external facts: approved provider credentials/licence confirmation, an approved production cutover, two evidence-model host-capacity checks, provisioned production middleware, and refreshed secured-development identities.

The supplied lifecycle and operating model is now mapped in `docs/attached-lifecycle-implementation-coverage.md`. The map covers payment initiation, identity and role checks, evidence-only KYC/KYB, RFQ/rate controls, funding and liquidity checks, durable execution workflow, provider-local payout boundary, reconciliation/reporting/audit, exception management, and event evidence. It distinguishes implemented control planes from provider-dependent movement rather than treating a diagram arrow as a completed settlement.

The provider-independent lifecycle gaps discovered by that audit are closed on canonical PostgreSQL. Migration 0013 produces **38** validated public tables, adding counterparty onboarding and immutable gate-decision evidence. The lifecycle is `legal_onboarding → technical_readiness → pilot → steady_state`, with blocked and due-recertification outcomes. Legal requires a verified authorisation; technical requires an active verified integration; pilot requires separate compliance and treasury actors. A 15-case router RBAC suite caught and closed a generic technical-gate bypass before this revision was recorded. The role-aware UI, DOM tests, and axe audit include the new controls.

Advanced analytics now receives a governed redacted lifecycle projection only after Dapr/Redis has validated and durably acknowledged the event. Bronze writes remain immutable and reject customer, account, wallet, document, credential, and raw-location fields. Sedona and GeoLibre remain aggregate-only clients; OCR/ML evidence remains review-required. The Go Yellow Card boundary implements documented HMAC RFQ creation and signed-webhook verification for **USDC/USDT** offers to **NGN/KES/ZAR**. It cannot accept a quote, create a wallet, move value, or assert settlement, and remains inactive pending licensed counterparties, secrets, allowlisting, and sandbox approval.

Closing validation for this revision: the managed suite ran with PostgreSQL and all live Go/Rust/Python/ledger/service regressions enabled — **83 files and 558 tests passed**. The Go payment-engine provider suite, including Yellow Card local protocol tests, passed with `go vet`. The Python lifecycle-event lakehouse projection and event-consumer regressions passed. The full canonical quality gate remains required after the final source synchronization.

## 2026-08-19 revision (secured-development validation and source-material guard)

This revision supersedes the summary below while retaining it as an audit
history. The ledger now records **176** items: **171 completed** and **5
externally blocked**, or **97.2%** checklist completion. The additional blocked
items separate a credential failure from a transport failure so neither can be
misrepresented as the other.

The supplied secured-development certificate material verified the Kafka,
Permify, and Temporal TLS chains without disabling verification. Kafka then
rejected the supplied SASL identity and Permify returned unauthorised for the
supplied bearer identity. No message, topic, policy, workflow, account,
transfer, or configuration was changed. The TigerBeetle private key was not
opened or used. The evidence is recorded without endpoint, credential, or key
material in `docs/external-secured-development-material-inspection.md`.

The provider-independent response is now complete: `make infra-check` includes
`scripts/infra/validate_secret_material.py`, which scans tracked source only
and rejects private-key markers, literal bearer values, literal
secret-shaped template assignments, and long literal values assigned to
credential-shaped declarations while allowing public certificates, named
deployment-secret references, and environment-derived values. Its six
regressions include negative controls for every refusal. This prevents future external material from entering source,
documentation, fixtures, templates, or the GitHub repository.

The Go payment engine now has a single TigerBeetle environment-composition
point: disabled is the default, and an enabled setting requires a complete
cluster, address, NGN/KES/ZAR ledger, account-code, transfer-code, transport,
and reachability configuration. It does not silently fall back if activation is
requested but invalid. The overview console now gives administrators, compliance
officers, treasury operators, and auditors a role-specific journey driven from
the displayed recorded signals, with navigation-only guidance and stated
authority boundaries. The provisioning and reconciliation architecture is
documented in `docs/tigerbeetle-activation-and-stakeholder-onboarding.md`.

### Remaining external release gates

| Gate | Required external input |
| --- | --- |
| Provider activation | A licensed counterparty confirmation and a current deployment-secret reference. |
| Transitional-store retirement | Approved production migration against a non-empty source and approved snapshot. |
| Evidence-only Ollama validation | A host with sufficient memory for the approved visual model. |
| Provisioned middleware deployment | Approved APISIX/open-appsec, TigerBeetle, Mojaloop, OpenSearch, Keycloak, Sedona/GeoLibre, and lakehouse environments. |
| Secured-development authenticated checks | Refreshed Kafka and Permify identities; TLS trust alone is verified but not service authorisation. |

## 2026-08-19 revision (auditable activation, operational history, and middleware integration)

This section supersedes the revisions below while retaining them as an audit
history. The managed ledger contains **172** tracked items: **167 completed**
and **5 externally blocked**, or **97.1%** implementation-checklist
completion. This is not a claim that a payment provider, regulator, or
production edge deployment has been activated.

The closing validation was deliberately layered. The managed suite ran with
PostgreSQL and every Go, Rust, Python, and ledger-gateway live service
regression enabled: **79 files and 529 tests passed with no skips**. The
canonical `make check` passed the Go, Rust, Python, TypeScript, contract, and
edge-configuration stages. The complete reporting-analytics pytest suite then
passed **62 tests**; document-intelligence passed **37 tests**; and the
canonical PostgreSQL database was purged, analysed, and confirmed to contain no
fixture rows.

### What was added in this revision

| Area | Measured implementation boundary |
| --- | --- |
| Credential governance | Secret-reference changes create attributable audit events recording old and new reference names, actor, and time — never the credential itself. The administrator console shows that history only to authorised administrators. |
| Operational visibility | Service observations persist as append-only PostgreSQL samples. The application role cannot alter or delete them; interactive charts render the recorded health and counter history and show gaps/unknowns rather than invented values. |
| Form recovery | Every console form provides a one-click retry only for transport failures that did not reach a business decision. Policy and lifecycle refusals remain non-retryable and retain the server’s exact reason. |
| Stakeholder language | Storage and deployment implementation terms were removed from operator copy without removing regulatory language that carries business meaning: Nigeria (NGN), Kenya (KES), South Africa (ZAR), CBN, CBK, SARB, SAR/STR, corridor, and final settlement evidence remain explicit. |
| Workflow and access | The Go payment engine has a live-server-tested Temporal workflow; the same engine verifies permissions with a live Permify deployment. Neither path invokes a provider without its separate provider gate. |
| Events and evidence | A live Go → Dapr → Redpanda → Python → Redis path was verified. Native Kafka, Dapr, and Fluvio clients fail closed on unavailable, insecure, or malformed configured transports. Redis is constrained by a mechanical runtime guard to at-least-once event evidence and de-duplication only, not an operational system of record. |
| Data, analytics, and maps | Keycloak federation, OpenSearch redacted projections, S3-compatible immutable lakehouse writes, Apache Sedona Livy submission, and GeoLibre aggregate project generation are implemented as real clients with local protocol regressions. They stay configuration-gated until a provisioned deployment exists. |
| Double-entry and edge | The payment engine uses the official TigerBeetle client for currency-ledger-scoped idempotent transfers; APISIX routes have mechanically verified Keycloak OIDC guards; open-appsec is configured as its official APISIX attachment-plus-agent prevention deployment; and the Mojaloop FSPIOP client returns only a signed asynchronous HTTP 202 reference, never a settlement claim. |

### Remaining external release gates

| Release gate | Why it cannot be closed by code in this environment |
| --- | --- |
| Licensed provider credential and counterparty activation | The administrator workflow, health probe, audit trail, secret-reference boundary, and fail-closed activation path exist. A real counterparty licence and secret are external facts that must not be fabricated. |
| Executed, reconciled production records-store migration | The transitional source has no business rows. The loader, dependency batches, checksums, and approval-hash gate are tested, but a real authorised migration requires the actual production source. |
| Evidence-only Ollama runtime validation | The measured host ceiling loads 0.5B and 1.5B models but kills 3B and above; a usable visual model exceeds this environment’s memory. The validator is committed and awaits a larger host. |
| APISIX/open-appsec, TigerBeetle, Mojaloop, OpenSearch, Keycloak, Spark/Sedona, GeoLibre, and lakehouse deployment checks | Their clients, templates, transport gates, and protocol regressions are implemented. The sandbox cannot host the production runtimes or supply the licensed scheme endpoints; the final live deployment check belongs to a provisioned, approved environment. |

The production-ready statement supported by this evidence is therefore:

> **UmojaFlowOS has a verified provider-independent control plane and
> activation-gated integrations. It is ready for authorised deployment
> validation, not authorised to represent live payment execution, regulatory
> submission, external scheme settlement, or automatic KYC/KYB outcomes.**

## 2026-08-19 revision (provider activation and observability)

This section supersedes the measured state recorded below it. Earlier revisions
are retained, because a readiness baseline that quietly rewrites its own history
is not a baseline.

The managed implementation ledger now contains **154** tracked items: **150
completed** and **4 open**, which is **97.4%** checklist completion. The ledger
grew by six items covering the credential interface, the status dashboard, and
the submission-feedback rollout, all of which are now complete.

Measured quality gates at this revision, each re-run at the close of the pass:
the managed suite passes **483 tests with no skips** when every live
cross-language regression is enabled, which starts the real Go, Rust, and Python
binaries and drives them through the real bridge; Go **23**; Rust **38** in the
risk core and **15** in the ledger gateway; Python **45** in reporting and **37**
in document intelligence. `make check` is green across all four languages,
TypeScript reports zero errors, and the canonical database is verified empty of
regression fixtures after the run.

### One position has changed materially

Previous revisions stated that no code path could set an integration to
`active`, and treated that as the strongest available guarantee. That is no
longer true, and the change is an improvement rather than a regression: exactly
one activation path now exists, and it cannot activate anything without a real
provider request returning 2xx. The guarantee has moved from *absence* to
*verification*, which is the stronger of the two, because an absent path would
have had to be written under time pressure at the moment a credential finally
arrived.

What has not changed is that no provider can be activated here. The remaining
requirement is a credential issued by a licensed counterparty, and neither the
credential nor the licence can be fabricated.

### What would move this from checklist completion to production readiness

Four things, none of which are code, and each unchanged in substance from the
previous revision:

| Requirement | Why code cannot supply it |
| --- | --- |
| An executed, reconciled production PostgreSQL cutover | The transitional source currently holds no business rows, so reconciliation has nothing real to compare |
| Credential-verified provider connections | A credential and a confirmed counterparty licence are external facts |
| A host able to load the 8B evidence models | Measured ceiling is roughly 1–1.9 GB of weights against 3.9 GB total memory |
| Regulator-confirmed submission channels | A submission reference is only meaningful if an authorised channel issued it |


## 2026-08-19 revision

This section supersedes the measured state recorded below it. The earlier text is retained, because a readiness baseline that quietly rewrites its own history is not a baseline.

The managed implementation ledger now contains **148** tracked items: **144 completed** and **4 open**, which is **97.3%** checklist completion. That number measures the ledger, not production readiness, and the two should not be conflated. All four remaining items are externally blocked and cannot be closed in any environment without input this project does not have: real provider adapters awaiting approved credentials and licensed counterparties, retirement of transitional MySQL/TiDB access awaiting an executed production cutover, and two Ollama evidence-only validations blocked by host memory.

Measured quality gates at this revision, each re-run at the close of the pass: the managed suite passes **396 tests with no skips** when every live cross-language regression is enabled, which starts the real Go, Rust, and Python binaries and drives them through the real bridge; Go **19**; Rust **34** in the risk core and **12** in the ledger gateway; Python **39** in reporting and **37** in document intelligence. `make check` is green across all four languages. The canonical database holds 35 validated tables and is verified empty of regression fixtures after each full run.

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
