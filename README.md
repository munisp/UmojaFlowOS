# UmojaFlowOS

UmojaFlowOS is an enterprise control plane for Africa-linked cross-border B2B payment orchestration across **Nigeria (NGN)**, **Kenya (KES)**, and **South Africa (ZAR)**. It coordinates regulated counterparties; it does not itself act as a bank, custodian, foreign-exchange dealer, stablecoin issuer, payment rail, or regulator.

## Service ownership

| Component | Language | Production responsibility |
|---|---|---|
| `apps/control-plane` | TypeScript | Authenticated operating console and typed API gateway |
| `services/payment-engine` | Go | Quotes, rate locks, payment lifecycle, routing, provider adapters, idempotency, and workflow control |
| `services/risk-compliance-core` | Rust | Policy gating, screening decisions, Travel Rule validation, counterparty risk, and velocity controls |
| `services/reporting-analytics` | Python | CBN, CBK, and SARB report validation, exposure calculation, and evidence manifests |
| `services/ledger-gateway` | Rust | Balanced monetary transfer validation and TigerBeetle command boundary |

## Non-negotiable activation policy

No provider integration is activated until its operator is recorded in the counterparty registry with verified regulatory authority and the required credentials are provisioned through the deployment secret manager. No environment may represent a payment, FX rate, USDC or USDT peg observation, sanctions-screening result, regulator submission, or notification delivery as live without a verified source and a recorded source timestamp.

## Local verification

Run `make check` from the repository root. It executes the Go, Rust, Python, and contract checks that do not require a credential or external network connection.

## Repository controls

The `main` branch is intended to be protected. Pull requests must pass contract compatibility, static analysis, tests, secret scanning, dependency review, and domain-owner review. Database migrations are forward-only PostgreSQL migrations. Production secrets, customer data, payment data, sanctions-list snapshots, report submissions, signing keys, and private provider material must never be committed.
