# UmojaFlowOS Architecture and GitHub Monorepo Strategy

## Architecture decision

UmojaFlowOS is a regulated-orchestration control plane, not a bank, stablecoin issuer, custodian, foreign-exchange dealer, or payment rail. It may compose instructions only after a jurisdiction-aware policy decision confirms the acting regulated entity, authorised counterparty, customer eligibility, screening result, risk decision, and reporting treatment. This preserves the required separation between system orchestration and money-bearing execution.

The platform’s production data layer is **PostgreSQL**, not MySQL. PostgreSQL stores operational metadata, case state, audit index records, idempotency responses, provider evidence, and reporting assembly state. A dedicated **TigerBeetle** cluster stores monetary account and transfer truth. PostgreSQL read projections never become a substitute ledger. The existing TypeScript dashboard scaffold may use its managed database only as a development control-plane shell; it is not the prescribed production ledger or production system of record.

| Layer | Responsibility | Runtime and language | Persistence and control |
|---|---|---|---|
| User interface and API gateway | Unified authenticated dashboard, typed BFF, role-aware procedures, audit presentation, configuration workflow | TypeScript with React, Express, and tRPC | PostgreSQL operational metadata through a contract adapter; no money writes |
| Payment orchestration | Quotes, rate locks, route plans, payment-order lifecycle, provider workflows, idempotency, signed callbacks, rail adapters | Go | PostgreSQL metadata, Temporal workflow state, Kafka events |
| Risk and compliance core | Sanctions-list normalization and matching, policy evaluation, transaction monitoring, counterparty risk, velocity checks, Travel Rule validation, immutable decision hashing | Rust | PostgreSQL case and rules metadata, Kafka inputs, signed decision evidence |
| Reporting and analytics | CBN, CBK, and SARB report-pack assembly, data-quality checks, regulator-specific export formatters, stablecoin exposure aggregation, evidence manifests | Python | PostgreSQL report metadata, Parquet object storage, Kafka event consumption |
| Ledger and custody boundary | Deterministic account and transfer writes, settlement linkage, custody command authorization | Rust | TigerBeetle monetary truth; PostgreSQL projection and evidence only |
| Shared operational infrastructure | Workflow execution, event transport, secret management, audit retention, observability, identity, policy distribution | Temporal, Kafka, Vault, OpenTelemetry, object storage, Keycloak or enterprise OIDC | Environment-specific infrastructure, encrypted, access-controlled, and independently monitored |

## Service contracts and non-negotiable invariants

All cross-service communication is contract-first. Protobuf service definitions and JSON Schema event definitions are versioned in one `contracts/` directory. Generated Go, Rust, Python, and TypeScript bindings are committed or generated deterministically in CI from the same versioned source. A service may not deserialize a peer’s private database record or use an unversioned HTTP payload as an integration contract.

| Invariant | Enforcement point | Failure behavior |
|---|---|---|
| No monetary instruction without an active corridor policy approval | Go orchestration workflow calls the Rust decision service synchronously | The order is blocked or put into manual review; no provider instruction is emitted |
| Every mutation is idempotent | API gateway, Go service, and provider adapter each bind key, actor, request hash, and response | A same-key different-body retry fails with an explicit conflict; a same-key same-body retry returns the original outcome |
| Every money movement has balanced ledger effects | Rust ledger gateway writes a linked double-entry transfer set | The workflow cannot advance to final settlement |
| Pending and final settlement remain distinct | Go payment state machine and user interface | The interface cannot label an unconfirmed provider leg as final |
| Sanctions potential matches are not automatic identities | Rust matching engine and TypeScript case workflow | Potential matches create review evidence and block according to policy; only authorised disposition can clear or reject |
| South Africa crypto-asset transfers require Travel Rule data when the participating entity falls within Directive 9 scope | Rust Travel Rule validator and Go orchestration gate | The workflow cannot execute a qualifying transfer lacking required data or counterparty diligence [1] |
| No external provider is treated as connected without current credentials and recorded authorization | Provider registry and secret-backed adapter startup checks | The adapter remains unavailable and the dashboard reports an honest configuration state |
| Every action is attributable | TypeScript procedure middleware and event envelope | The application stores actor, role, reason, object, before/after hashes, timestamp, correlation ID, and policy version |

## Domain model

The operational model is centred on a regulated `LegalEntity`, a `CorridorPolicy` for Nigeria (NGN), Kenya (KES), or South Africa (ZAR), and a `CounterpartyAuthorization` record. A payment requires an accepted quote, an order, one or more execution legs, a risk decision, and ledger references. It is never represented as a single opaque status field.

The core entities are customer, beneficial owner, KYC/KYB case, beneficiary, counterparty, legal entity, regulator-authority evidence, corridor policy, liquidity pool, nostro/vostro account, prefunding position, rate quote, stablecoin observation for USDC or USDT, rate lock, payment order, execution leg, settlement instruction, Travel Rule message, risk decision, screening result, compliance case, SAR/STR record, report pack, submission attempt, alert policy, notification delivery, and append-only activity event.

## Corridor-specific control posture

Nigeria (NGN) must retain SEC classification and registration evidence where the activity falls within the SEC digital-assets rules. CBN VASP banking and IMTO/FX permissions are separate dependencies, because the reviewed primary CBN material does not establish an operative generic permission for the platform itself. Kenya (KES) must apply the VASP Act’s in-or-from-Kenya licensing controls and must not treat the 2026 draft regulations as final. South Africa (ZAR) must classify financial-service activity under FAIS, establish FIC Directive 9 applicability, and route foreign-exchange activity through the authorised participant model reflected in SARB materials. [2] [3] [4] [5] [6]

## Deployment alternatives requiring a user decision

The requested Go, Rust, Python, Temporal, Kafka, TigerBeetle, PostgreSQL, and controlled background-worker stack cannot run as a single managed TypeScript-only web process. The dashboard can remain separately hosted, but the multi-language control plane requires a deployment environment that supports containers, persistent workloads, network policies, and independently managed databases.

| Approach | What runs where | Trade-offs | Cost and setup complexity |
|---|---|---|---|
| Managed cloud production topology | A managed Kubernetes or container platform runs Go, Rust, Python, Temporal workers, Kafka, TigerBeetle, PostgreSQL, Vault, and observability; the TypeScript dashboard deploys as a separate web application. | Provides the required language runtimes, high availability, network segmentation, regional controls, and auditable operational boundaries. It requires cloud account access, regulated vendor contracts, infrastructure credentials, and a security review. | Highest setup and operating cost; appropriate for a regulated production launch. |
| Single-host non-production integration topology | Docker Compose runs the same multi-language services, PostgreSQL, Temporal, Kafka-compatible event transport, and TigerBeetle on one secured non-production host; the TypeScript dashboard integrates with it. | Supports real executable service interactions and contract tests, but does not provide the high availability, segregation, data-residency, or operational resilience required for a regulated production rollout. | Lower setup cost and complexity; appropriate for authorised sandbox partners and system integration testing only. |

Neither approach substitutes for legal licensing, contracted payment providers, or authorised reporting channels. The first approach is the recommended production target; the second is an implementation and integration environment. The selected deployment option determines infrastructure-as-code, secret provisioning, network policy, and CI/CD deployment targets.

## GitHub monorepo strategy

The selected repository `munisp/UmojaFlowOS` is empty and should become the canonical monorepo. The repository’s organisation-owned main branch remains protected. Deployable artifacts are produced from immutable commits, never from unreviewed workspace state. The repository must contain no production secrets, customer documents, payment data, sanctions-list copies, signing keys, or exported SAR/STR submissions.

```text
UmojaFlowOS/
├── apps/
│   └── control-plane/                 # TypeScript React, Express, tRPC dashboard and BFF
├── services/
│   ├── payment-engine/                # Go: quotes, orders, routing, provider adapters, workflows
│   ├── risk-compliance-core/           # Rust: screening, policy, Travel Rule, risk, velocity
│   ├── reporting-analytics/            # Python: reporting, exposure aggregation, validation
│   └── ledger-gateway/                 # Rust: TigerBeetle command boundary and projections
├── contracts/
│   ├── proto/                          # Protobuf RPC and event contracts
│   ├── jsonschema/                     # Signed webhook and report schemas
│   └── policy/                         # Versioned corridor-policy bundles
├── packages/
│   ├── design-system/                  # TypeScript International Typographic Style UI system
│   ├── generated/                      # Generated contract bindings only
│   └── test-fixtures/                  # Synthetic non-production test data, never used by runtime
├── infrastructure/
│   ├── compose/                        # Single-host integration topology
│   ├── kubernetes/                     # Production manifests and policy objects
│   ├── terraform/                      # Cloud resources and secret references
│   └── observability/                  # Dashboards, SLOs, alerts, runbooks
├── database/
│   ├── postgresql/                     # Versioned operational migrations
│   └── tigerbeetle/                    # Account and transfer topology definitions
├── docs/
│   ├── adr/                            # Architecture decision records
│   ├── compliance/                     # Control mapping and counsel-review package
│   ├── operations/                     # Incident, reconciliation, and key-rotation runbooks
│   └── api/                            # Published API standards
├── scripts/                            # Deterministic build and contract-generation scripts
└── .github/
    ├── workflows/                      # CI, security, contract, release, and deploy workflows
    ├── CODEOWNERS
    ├── dependabot.yml
    └── pull_request_template.md
```

| Branch or release rule | Required control |
|---|---|
| `main` | Protected; linear history; signed commits or verified GitHub identity; no direct pushes; production-ready only |
| Feature branches | Conventional branch names by domain, for example `payment/`, `risk/`, `reporting/`, `control-plane/`, `infra/`, and `contracts/` |
| Pull request | At least one domain owner review plus mandatory checks; two approvals for `contracts/`, `policy/`, `database/`, `infrastructure/`, or security-sensitive changes |
| Contract changes | Compatibility check against prior published version; generated bindings rebuilt; consumer contract tests pass before merge |
| Database migration | Forward-only PostgreSQL migration, review by data owner, rollback plan in the PR, and no destructive schema change without approved migration plan |
| Release | Semantic version tags; SLSA-style provenance/attestation where the chosen CI platform supports it; image digest promotion from test to production |
| Secret handling | GitHub Actions OIDC to the deployment secret manager; secret scanning, push protection, least-privilege environment approvals, and no long-lived cloud credentials in repository variables |

## Continuous integration and delivery gates

Every pull request runs formatting, static analysis, unit tests, contract compatibility tests, dependency and licence scanning, secret scanning, container build validation, infrastructure policy checks, and database migration linting. Payment, risk, and reporting service tests additionally run deterministic integration scenarios against real local services, never runtime mock endpoints. Production deployment requires an approved release, environment protection rule, verified migrations, a current regulatory-policy bundle, a successful secret/connection health check, and evidence that every activated provider is authorised for the selected corridor.

## References

[1] [Financial Intelligence Centre, Directive 9](https://www.fic.gov.za/wp-content/uploads/2024/11/Directive-9-Travel-rule-relating-to-crypto-asset-transfers.pdf)

[2] [Nigeria SEC, New Rules on Issuance, Offering Platforms and Custody of Digital Assets](https://home.sec.gov.ng/documents/8/Rules-on-Issuance-Offering-and-Custody-of-Digital-Assets.pdf)

[3] [Central Bank of Nigeria, Reforms and Initiatives](https://www.cbn.gov.ng/AboutCBN/Reforms.html)

[4] [Kenya Law, Virtual Asset Service Providers Act, No. 20 of 2025](https://new.kenyalaw.org/akn/ke/act/2025/20/eng@2025-11-04)

[5] [Central Bank of Kenya, Draft VASP Regulations 2026 notice](https://www.centralbank.go.ke/2026/03/18/public-notice-invitation-for-comments-from-the-public-on-the-draft-virtual-asset-service-providers-regulations-2026/)

[6] [South African Reserve Bank, Currency and Exchanges Manual for Authorised Dealers](https://www.resbank.co.za/content/dam/sarb/what-we-do/financial-surveillance/financial-surveillance-documents/2026/Currency%20and%20Exchanges%20Manual%20for%20Authorised%20Dealers.pdf)
