# UmojaFlowOS Implementation Handover

## Delivered components

The TypeScript control plane is implemented as an authenticated operator console with a managed relational database, typed tRPC procedures, role-aware server enforcement, and attributable activity records. It implements data capture and review flows for the Nigeria (NGN), Kenya (KES), and South Africa (ZAR) corridors; CBN, CBK, and SARB policy records; counterparties; provider connections; customers and beneficiaries; liquidity positions; USDC and USDT market observations; payment drafts; compliance cases; report packs; and alert policies.

| Capability | Delivered behavior | Activation boundary |
|---|---|---|
| Payment orchestration | Creates idempotent payment-order drafts in `pending_policy_decision`; records an immutable activity event. | A draft cannot be represented as executing or completed without verified policy, authorised counterparty, and provider finality evidence. |
| Treasury | Captures reconciled liquidity-pool, nostro, vostro, pre-funding, and custody-wallet evidence. | No balance is ingested automatically until a verified source integration is active. |
| FX and stablecoins | Stores source-stamped NGN, KES, ZAR, USDC, and USDT observations only from active integrations. | The application rejects market observations from unconfigured or unverified connections. |
| Compliance | Records KYC, sanctions, transaction-monitoring, Travel Rule, counterparty, and SAR/STR cases with evidence references. | No sanctions match, KYC result, or regulatory disposition is fabricated; a provider or approved manual evidence source is required. |
| Reporting | Creates CBN, CBK, and SARB report-pack drafts. | Submission is not asserted until an approved channel returns a submission reference. |
| Registry and alerts | Stores regulated counterparty and connection records, alert policies, and owner-alert attempts. | Provider authorization, credentials, health checks, and delivery results remain explicit. |

## Monorepo components

The canonical `munisp/UmojaFlowOS` monorepo contains a Go payment-engine domain state machine, a Rust risk/compliance policy core, a Rust balanced-ledger gateway, a Python report-evidence package, versioned Protobuf contracts, PostgreSQL topology, CI checks, source-validation documentation, and a copy of the TypeScript control plane under `apps/control-plane`.

| Service | Implemented control | Readiness boundary |
|---|---|---|
| Go payment engine | Corridor and currency validation; policy, provider-verification, and finality guards. | Requires deployment target, durable workflow state, and approved rail adapter credentials. |
| Rust risk/compliance core | Fails closed on unauthorised entity/counterparty, absent KYC, confirmed or unavailable sanctions source, Travel Rule incompleteness, and velocity breach; sends potential matches to review. | Requires approved sanctions, KYC, Travel Rule, and velocity data sources. |
| Rust ledger gateway | Validates a per-currency balanced posting set before any ledger command. | Requires deployed TigerBeetle topology and segregation-of-duties key management. |
| Python reporting analytics | Validates CBN, CBK, and SARB report-pack essentials and creates a SHA-256 evidence manifest. | Requires approved report specifications, source records, counsel review, and any regulator submission channel. |

## Validation record

The managed control plane compiled successfully with TypeScript. The Vitest suite passed with three tests covering session logout and negative RBAC enforcement. The production build completed. Desktop and mobile visual inspections confirmed the required International Typographic Style, accessible contrast, responsive layout, and zero-state honesty. The Go, Rust, Python, and contract checks passed locally except for Cargo Clippy, which is preserved as a GitHub Actions requirement because the sandbox distribution does not package that component.

## Required activation inputs

The following inputs are intentionally not invented and must be supplied before any provider-backed capability is activated.

| Input | Required for |
|---|---|
| Approved legal entity and licensing evidence per Nigeria, Kenya, and South Africa corridor | Payment, FX, stablecoin, custody, and regulatory workflows |
| Named licensed payment, banking, FX, stablecoin, custody, KYC/KYB, sanctions, Travel Rule, chain-analytics, and reporting counterparties | Provider routing and compliance controls |
| Sandbox or production credentials, official documentation, callback requirements, and permitted scope | Provider adapters, health checks, data ingestion, and webhooks |
| Production deployment selection and cloud credentials | Go, Rust, Python, PostgreSQL, TigerBeetle, workflow, and event runtimes |
| Counsel-approved reporting templates and official submission procedures | CBN, CBK, and SARB file assembly and submission |

## Regulatory reference boundary

This implementation records controls derived from the verified source package. It does not provide legal advice, assert any licence, submit a report, or activate a payment service on the basis of the internal research alone. The corridor policy files must be reviewed and approved by authorised counsel and the responsible regulated entity before activation. The source validation record remains in `docs/regulatory-control-validation.md` and the monorepo compliance documentation. [1] [2] [3] [4]

## References

[1] [Financial Intelligence Centre, Directive 9](https://www.fic.gov.za/wp-content/uploads/2024/11/Directive-9-Travel-rule-relating-to-crypto-asset-transfers.pdf)

[2] [Nigeria Securities and Exchange Commission, Digital Assets Rules](https://home.sec.gov.ng/documents/8/Rules-on-Issuance-Offering-and-Custody-of-Digital-Assets.pdf)

[3] [Kenya Law, Virtual Asset Service Providers Act, 2025](https://new.kenyalaw.org/akn/ke/act/2025/20/eng@2025-11-04)

[4] [South African Reserve Bank, Currency and Exchanges Manual for Authorised Dealers](https://www.resbank.co.za/content/dam/sarb/what-we-do/financial-surveillance/financial-surveillance-documents/2026/Currency%20and%20Exchanges%20Manual%20for%20Authorised%20Dealers.pdf)
