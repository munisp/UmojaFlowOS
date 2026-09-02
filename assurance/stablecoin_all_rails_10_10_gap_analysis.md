# Stablecoin All-Rails 10/10 Technical Gap Analysis

## Executive decision

UmojaFlowOS has a strong settlement-control core: PostgreSQL provides durable workflow and idempotency state, TigerBeetle provides the authoritative double-entry transfer fact, and Hyperledger Fabric provides consortium attestation. The current technical readiness is **7.5/10** for the implemented control plane. A defensible 10/10 requires closing the execution-rail, custody, blockchain-finality, compliance, reconciliation, observability, resilience, and independent-assurance gaps below.

A local implementation can close interface contracts, fail-closed state handling, test harnesses, redaction, and evidence packaging. It cannot manufacture provider approvals, HSM ceremonies, bank connectivity, blockchain network behavior, consortium endorsement, or regulatory authorization. Those items remain external evidence gates.

## Target architecture

```text
Bank / PSP / IMTO  ─┐
Custody / wallet    ├─> Stablecoin Settlement Coordinator ─> PostgreSQL
Issuer / liquidity  ┘                                  ├─> TigerBeetle
Blockchain finality ──────────────── read-only proof ───└─> Fabric attestation
```

The coordinator owns policy, idempotency, state transitions, reconciliation, and release decisions. No provider writes directly to PostgreSQL or TigerBeetle. Fabric remains attestation-only and cannot authorize financial settlement.

## Gap register

| ID | Domain | Current state | 10/10 requirement | Closure type | Gate |
|---|---|---|---|---|---|
| G-01 | Fiat execution | Provider-neutral stablecoin adapter exists; no live bank/PSP/IMTO execution | Approved adapters with quote, collection, payout, refund, webhook, idempotency, limits, and reconciliation | Code + external | P0 |
| G-02 | Custody | Interface/design and identity controls exist; no live custody execution | HSM-backed custody/wallet adapter with address policy, segregation, withdrawal approval, balance proof, and recovery | Code + external | P0 |
| G-03 | Issuer/liquidity | Issuer evidence governance exists; no live mint/redeem/liquidity path | Approved issuer adapter with reserve, mint, redeem, quote, settlement, and counterparty limits | Code + external | P0 |
| G-04 | Blockchain finality | Design contract exists; no live chain observer | Chain-specific finality provider with confirmation depth, reorg detection, nonce/fee handling, chain halt, and proof retention | Code + external | P0 |
| G-05 | Multi-system reconciliation | Durable settlement identity exists | Scheduled and event-triggered reconciliation across fiat, provider, custody, chain, TigerBeetle, PostgreSQL, and Fabric evidence | Code | P0 |
| G-06 | AML/CFT/CPF | Governance/reporting paths exist; no full live path evidence | Screening before execution, sanctions, Travel Rule where applicable, risk score, escalation, case disposition, SAR/STR decision, and immutable audit | Code + external | P0 |
| G-07 | Failure state machine | UNKNOWN and terminal immutability are implemented | Every provider, custody, chain, and ledger timeout maps to held/UNKNOWN and read-only reconciliation | Code | P0 |
| G-08 | Cross-region safety | Deterministic split-brain simulation exists | Real PostgreSQL replication-lag, fencing, failover, and cross-replica evidence with measured RPO/RTO | External | P0 |
| G-09 | Observability | OTel Collector, Prometheus, Alertmanager, and Novu bridge exist | Live traces/metrics from every adapter, alerts delivered, tenant isolation proven, and SLOs monitored | Code + external | P1 |
| G-10 | Security | X.509/HSM guidance and adapter validation exist | Non-exportable keys, mTLS, rotation, revocation, dual control, secret manager, SBOM, vulnerability closure, and pen-test evidence | Code + external | P1 |
| G-11 | Resilience | Local fault simulations exist | Provider outage, custody outage, chain reorg/congestion, issuer outage, alert loss, restore, and rollback drills | External | P1 |
| G-12 | Governance | Fabric consortium template exists | Signed agreement, MSP/CA roster, channel configuration, endorsement policy, dispute, suspension, and exit approval | External | P1 |
| G-13 | Evidence | Release manifest and detached-signature validator exist | E-01–E-09 immutable bundle, four distinct signers, verified subjects, common SHA, and independent E-09 review | External | P0 |

## P0 implementation specification

### Fiat adapter

The adapter must expose quote, create collection, create payout, get status, cancel/refund where supported, and verify webhook methods. Every request must carry the platform settlement ID and a provider-specific idempotency key derived from the immutable PostgreSQL identity. A returned provider reference is mandatory for any submitted or pending state. A timeout is UNKNOWN, not failed.

### Custody adapter

The custody adapter must create or select a controlled wallet, submit a policy-authorized transfer, query transfer status, query balance, and verify address/network/asset binding. Signing must occur through an HSM or approved remote signer. The application must never receive exportable wallet keys. Withdrawal and recovery require dual control.

### Finality adapter

The finality provider must return transaction inclusion, block identity, confirmation depth, canonical chain status, and reorganization status. A transaction is not final until the configured asset/network threshold is satisfied. Reorg, chain halt, provider disagreement, or unavailable proof keeps the settlement held.

### Reconciliation worker

Reconciliation must compare immutable identities and facts, not mutable display fields. It must be lease-based, cross-replica safe, idempotent, and read-only against providers. It must classify records as matched, missing, conflicting, delayed, or manual-review-required. Any discrepancy blocks settlement and opens an evidence case.

## Evidence required for 10/10

| Evidence | Minimum acceptance |
|---|---|
| Bank/PSP/IMTO | Authorized staging transaction, webhook verification, timeout, duplicate, refund, and reconciliation logs. |
| Custody/HSM | Key ceremony, signer test, rotation, revocation, quorum-loss, withdrawal-policy, and restore records. |
| Blockchain | Testnet transfer, finality threshold, reorg simulation, chain halt, fee/nonce handling, and proof digest. |
| AML/CFT/CPF | Clear/hit/false-positive/high-risk/provider-unavailable cases, case escalation, disposition, and immutable audit trail. |
| Reconciliation | Zero unexplained discrepancies across all systems after normal, timeout, failover, and recovery runs. |
| Resilience | RTO/RPO, failover, rollback, alert delivery, and post-exercise review with CAP. |
| Fabric consortium | Real MSP identities, endorsement event, channel policy, chaincode digest, and commit proof. |
| Release assurance | E-01–E-09 manifest, SHA-256 artifact bindings, four independent approvals, detached signatures, and E-09 review. |

## Readiness scoring

The platform may claim 10/10 only when every P0 is closed, every P1 is closed or formally accepted by the authorized governance body, no evidence item is synthetic-only, no material external dependency remains untested, and all approvals reference the same immutable release SHA.

Until then, the correct status is **technically conditional and regulatory NO-GO**. Passing local simulations is evidence of control behavior, not evidence of provider authorization, production operation, or CBN approval.
