# Stablecoin Onramp/Offramp Readiness Assessment

## Executive conclusion

UmojaFlowOS has a **strong stablecoin governance, evidence, orchestration-readiness, and exposure-reporting foundation**, but the repository does not currently demonstrate a complete production onramp/offramp execution rail. The implemented surface is best characterized as a **controlled stablecoin provider/issuer assessment and execution-rehearsal layer**, not a fully integrated fiat-to-stablecoin and stablecoin-to-fiat settlement product.

**Overall readiness score: 4.5/10 — partially implemented; not production-ready for customer onramp/offramp activation.**

This score is an engineering readiness assessment derived from the inspected source and migrations. It is not a regulatory approval, provider certification, or financial recommendation.

## Scope assessed

The assessment covers:

- Stablecoin issuer/counterparty evidence and gate decisions.
- Stablecoin route and execution-rehearsal schema.
- Travel Rule, beneficiary-verification, and wallet-ownership evidence references.
- Stablecoin exposure reporting for USDC/USDT across NGN, KES, and ZAR corridors.
- Payment-engine integration, provider adapters, idempotency, reconciliation, custody, mint/redeem, and fiat settlement evidence.

## Scorecard

| Capability | Score | Finding |
|---|---:|---|
| Issuer/counterparty governance | 8/10 | Implemented archetypes, 11-item evidence taxonomy, dedicated gate decisions, role restrictions, and activity logging. |
| Route and execution preconditions | 6/10 | Database structures exist for routes, evidence prerequisites, approvals, and rehearsal outcomes; live execution proof is absent. |
| Financial exposure reporting | 8/10 | Fail-closed reconciled-position aggregation with stale-evidence, source-reference, peg-observation, and no-accounting-side-effect controls. |
| Onramp execution | 2/10 | No inspected end-to-end fiat collection, bank/PSP debit, stablecoin acquisition, custody, mint, or beneficiary-credit adapter was demonstrated. |
| Offramp execution | 2/10 | No inspected end-to-end stablecoin redemption, custody release, fiat payout, bank/PSP settlement, or beneficiary confirmation path was demonstrated. |
| Provider integration | 4/10 | Platform has provider-neutral multi-rail patterns and stablecoin-provider governance, but the inspected stablecoin code is primarily evidence/workspace logic rather than a live execution adapter. |
| Reconciliation and UNKNOWN safety | 7/10 | The wider payment engine has durable UNKNOWN-state and reconciliation controls; stablecoin-specific end-to-end reconciliation evidence remains pending. |
| Compliance and sanctions controls | 6/10 | Evidence types and route prerequisites exist; live AML/CFT/CPF, Travel Rule, wallet screening, sanctions, and escalation integrations are not proven in this surface. |
| Operational resilience | 4/10 | General multi-rail and observability controls exist; stablecoin-provider outage, chain congestion, de-peg, custody outage, and redemption failure drills are not evidenced. |
| Auditability | 7/10 | Activity events, evidence URIs, recorded actors, timestamps, and dedicated gate decisions are present; immutable live evidence and independent approvals are still required. |

## What is implemented

### 1. Issuer evidence and governance

`apps/control-plane/server/stablecoinIssuerEvidence.ts` implements:

- Three stablecoin issuer/network archetypes: regulated issuer, open issuer, and network.
- An 11-item issuer evidence pack, including licence, reserve attestation, reserve composition, AML/CFT policy, sanctions attestation, chain finality, custody licence/insurance, network fees, beneficial ownership/KYB, audited financials, and smart-contract audit.
- Four issuer-specific gate types: licence/reserve posture, mint/redeem technical proof, chain readiness, and operating posture.
- Role restrictions for gate decisions.
- Transactional writes with rollback on failure.
- Activity-event recording for archetype changes, evidence recording, and gate decisions.
- Workspace reads combining counterparty identity, evidence items, authorizations, onboarding, gate decisions, and activity history.

These are meaningful controls for approving a stablecoin provider or issuer, but they are not themselves an onramp/offramp execution implementation.

### 2. Route and rehearsal schema

The database migrations define structures for stablecoin orchestration routes, route reviews, execution-approval rehearsals, and stablecoin execution evidence. The execution evidence categories include Travel Rule, beneficiary verification, and wallet ownership. The schema also enforces evidence URI and SHA-256 format constraints and records actor/time metadata.

The strongest safety property is that rehearsal records explicitly require `external_execution_initiated = FALSE`. This supports dry-run governance, but a controlled rehearsal cannot be presented as a successful live transaction.

### 3. Exposure analytics

`services/reporting-analytics/src/umojaflowos_reporting/stablecoin_exposure.py` is robust for its declared purpose: fail-closed exposure reporting from reconciled positions. It validates supported corridors/assets, finite non-negative amounts, source references, timezone-aware reconciliation timestamps, stale-position limits, peg observations, and observation freshness. It reports peg deviation as an observation and intentionally creates no accounting entry or rebalancing instruction.

This is **risk and exposure analytics**, not custody, conversion, minting, redemption, or fiat payout.

## Missing or unproven onramp capabilities

The inspected repository evidence does not demonstrate all of the following as a complete executable path:

1. Customer fiat collection through an approved Nigerian bank, PSP, IMTO, or payment provider.
2. KYC/AML decision before accepting funds.
3. Quote creation with expiry, fees, FX basis, slippage limits, and customer disclosure.
4. Fiat authorization, debit, settlement confirmation, and idempotent retry behavior.
5. Stablecoin acquisition through an approved liquidity or issuer adapter.
6. Custody wallet allocation, address ownership proof, chain selection, and network-fee handling.
7. Blockchain transaction submission, confirmation depth, finality, and reorganization handling.
8. Stablecoin credit to the beneficiary or customer ledger.
9. Complete reconciliation among fiat provider, internal ledger, custody/wallet, and blockchain transaction hash.
10. Customer-facing status, cancellation, refund, exception, and dispute flows.

## Missing or unproven offramp capabilities

The repository does not demonstrate a complete executable offramp path covering:

1. Stablecoin deposit/address assignment and chain/network validation.
2. Wallet ownership, Travel Rule, sanctions, and source-of-funds checks before acceptance.
3. Blockchain confirmation/finality and reorganization protection.
4. Stablecoin custody debit or redemption request.
5. Issuer or liquidity-provider redemption confirmation.
6. Fiat conversion quote, fee, spread, and expiry handling.
7. Bank/PSP payout initiation and final settlement confirmation.
8. Duplicate payout prevention across provider retries and UNKNOWN states.
9. Failed redemption, de-peg, chain congestion, custody outage, and payout return handling.
10. Final customer confirmation tied to immutable provider, ledger, and blockchain evidence.

## Integration robustness assessment

### Strong integration points

The stablecoin surface integrates well with the platform’s **control-plane governance model**. It uses canonical counterparties, dedicated evidence records, role-constrained decisions, transactional database writes, activity events, and an issuer workspace. It also aligns with the wider payment engine’s provider-neutral rail and UNKNOWN-state safety principles.

The reporting-analytics integration is also strong for monitoring exposure. It refuses to produce a figure if reconciliation or peg evidence is absent or stale, which is appropriate for compliance and treasury reporting.

### Weak or incomplete integration points

The main weakness is the missing end-to-end connection between those governance records and an actual execution rail. The inspected stablecoin code does not prove a complete adapter that can safely coordinate:

```text
Bank/PSP/IMTO fiat movement
        ↕
Stablecoin provider or liquidity venue
        ↕
Custody/wallet and blockchain
        ↕
TigerBeetle/internal ledger
        ↕
Customer status, AML case, reconciliation, and reporting
```

The provider-neutral Go multi-rail infrastructure is a useful foundation, but a stablecoin-specific adapter still needs to implement the complete lifecycle and bind every external result to an idempotency key, customer/order reference, provider reference, blockchain transaction hash, ledger decision, and immutable evidence record.

## Required remediation before production readiness

| Priority | Remediation | Acceptance evidence |
|---|---|---|
| P0 | Define the approved onramp/offramp product boundary and permitted assets, corridors, customer types, and limits. | Signed product-boundary document and route-level policy tests. |
| P0 | Implement provider adapter interfaces for fiat collection, stablecoin acquisition/redemption, custody, and payout. | Go adapter contract tests and authorized staging integration tests. |
| P0 | Bind lifecycle state to idempotency, provider references, blockchain hashes, and internal ledger entries. | Duplicate, timeout, UNKNOWN, replay, and reconciliation tests. |
| P0 | Implement fail-closed chain confirmation/finality and reorganization handling. | Controlled chain reorg/congestion test and evidence. |
| P0 | Implement pre-transaction AML/CFT/CPF, sanctions, wallet-risk, Travel Rule, and beneficiary checks. | Approved policy fixtures, decision logs, escalation/case evidence, and MLRO review. |
| P0 | Implement fiat and stablecoin reconciliation with zero unexplained discrepancy requirement. | Independent PostgreSQL/TigerBeetle/provider/blockchain reconciliation report. |
| P1 | Add quote, fee, spread, slippage, expiry, refund, cancellation, and dispute controls. | API and state-machine tests plus customer disclosure evidence. |
| P1 | Add custody and key-management controls, including HSM/mTLS, address whitelisting, withdrawal limits, and emergency freeze. | Key ceremony, secret rotation, withdrawal-policy, and freeze-drill records. |
| P1 | Add provider and chain resilience tests. | Provider timeout, issuer outage, chain congestion, de-peg, custody outage, and payout failure evidence. |
| P1 | Add OTel spans/metrics for the full stablecoin lifecycle without sensitive payloads. | Trace graph from quote through final settlement and redaction review. |
| P1 | Add four-role release approval and immutable evidence binding. | E-09 manifest, four distinct subjects, detached signatures, and independent review. |

## Recommended state model

Onramp and offramp should use an explicit state machine with terminal decisions written once:

```text
CREATED
  → QUOTED
  → COMPLIANCE_PENDING
  → COMPLIANCE_APPROVED
  → FIAT_PENDING / ASSET_PENDING
  → PROVIDER_SUBMITTED
  → UNKNOWN
  → RECONCILIATION_PENDING
  → SETTLED | FAILED | REFUNDED | BLOCKED
```

No state transition should settle customer funds when the external provider or blockchain result is UNKNOWN. A second rail may be used only after non-submission is proven or the original provider’s state is conclusively reconciled.

## Final disposition

**Stablecoin issuer governance:** comparatively mature and auditable.

**Stablecoin exposure reporting:** strong and fail-closed for reconciled data.

**Onramp/offramp execution:** incomplete in the inspected repository; no production activation should be claimed.

**Overall:** the platform can credibly support stablecoin provider due diligence, controlled execution rehearsals, compliance evidence, and exposure monitoring. It is not yet a fully integrated customer onramp/offramp execution platform until the missing provider, custody, blockchain, fiat payout, reconciliation, AML, resilience, and independent-staging evidence are implemented and verified.
