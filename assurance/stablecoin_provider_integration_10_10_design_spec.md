# Stablecoin Provider Integration Design Specification

## 1. Executive design decision

UmojaFlowOS should integrate approved fiat, custody, issuer/liquidity, and blockchain-finality providers through **provider-neutral adapters** behind one settlement coordinator. The coordinator must own policy, idempotency, state transitions, reconciliation, observability, and fail-closed behavior; provider adapters must own protocol translation and provider-specific authentication.

The design target is a defensible **10/10 production-readiness state**, meaning all code paths, external integrations, operational controls, and independent evidence gates are closed. A code-complete adapter alone is not sufficient for that rating.

The design preserves the existing architecture:

```text
Control Plane / API
        │
        ▼
Policy + AML/CFT/CPF + limits + consent
        │
        ▼
Stablecoin Settlement Coordinator
        ├── Fiat Rail Adapter: bank / PSP / IMTO
        ├── Stablecoin Issuer or Liquidity Adapter
        ├── Custody / Wallet Adapter
        ├── Blockchain Finality Adapter
        ├── TigerBeetle / Ledger Adapter
        └── PostgreSQL durable idempotency and evidence store
```

The existing `multirail.Rail` contract, durable UNKNOWN-state logic, `stablecoin_settlement_attempts` migration, issuer evidence gates, and exposure reporting remain the foundation.

## 2. Provider boundary and responsibility model

| Component | UmojaFlowOS owns | Provider owns | Required contract |
|---|---|---|---|
| Fiat bank/PSP/IMTO | Order state, limits, compliance decision, idempotency, reconciliation, customer status | Debit, payout, bank reference, settlement status | `SubmitCollection`, `SubmitPayout`, `Query`, webhook verification |
| Issuer/liquidity provider | Asset policy, quote policy, execution state, provider-reference binding | Quote, buy/sell, mint/redeem, liquidity response | `CreateQuote`, `Execute`, `Query`, `Cancel` where supported |
| Custody/wallet | Address policy, withdrawal limits, approval, ledger binding, reconciliation | Address allocation, signing, broadcast, custody status | `CreateDepositAddress`, `Transfer`, `QueryTransfer`, `Freeze` |
| Blockchain finality | Confirmation policy, chain/network allowlist, reorg handling, evidence | Block/transaction observation and chain data | `ObserveTransaction`, `GetFinality`, `GetBlockStatus` |
| TigerBeetle/internal ledger | Double-entry postings, settlement gating, reconciliation | None | Idempotent posting and authoritative internal balance state |

No provider may write directly to PostgreSQL or TigerBeetle. All provider results must pass through the coordinator, be validated, and be bound to the originating intent.

## 3. Canonical settlement intent

The coordinator must create a canonical, versioned intent before calling any provider:

```json
{
  "intent_version": 1,
  "intent_id": "uuid",
  "payment_order_id": "uuid",
  "payment_leg_id": "uuid",
  "idempotency_key": "customer-order-direction-version",
  "direction": "onramp",
  "fiat_currency": "NGN",
  "asset": "USDC",
  "amount_minor": 125000,
  "quote_id": "provider-or-internal-quote-reference",
  "beneficiary_reference": "pseudonymous-reference",
  "tenant_scope": "tenant-a",
  "policy_version": "policy-hash-or-version",
  "expires_at": "2026-09-01T12:05:00Z"
}
```

The canonical JSON must use deterministic key ordering and UTF-8 encoding. Its SHA-256 digest is stored in `stablecoin_settlement_attempts.payload_sha256`. Raw customer, account, wallet, KYC, or payment payloads must not appear in logs, traces, metrics, or alert bodies.

## 4. Adapter interfaces

### 4.1 Fiat adapter

```go
type FiatRail interface {
    Name() string
    SubmitCollection(context.Context, FiatCollectionRequest) (FiatSubmission, error)
    SubmitPayout(context.Context, FiatPayoutRequest) (FiatSubmission, error)
    Query(context.Context, FiatQueryRequest) (FiatStatus, error)
    VerifyWebhook(context.Context, []byte, http.Header) (FiatWebhook, error)
}
```

The adapter must validate currency, amount, beneficiary reference, expiration, provider reference, and signature before returning a result. A timeout after transmission is `UNKNOWN`, not `FAILED`. A retry is permitted only when the provider contract proves that no business effect occurred.

### 4.2 Issuer/liquidity adapter

```go
type StablecoinExecutionClient interface {
    Submit(context.Context, StablecoinExecutionRequest) (StablecoinExecutionResponse, error)
    Query(context.Context, StablecoinExecutionRequest) (StablecoinExecutionResponse, error)
}
```

The implemented `StablecoinRail` should be extended with quote and redemption semantics. Every quote must include asset, fiat, rate, fee, spread, expiry, provider quote reference, and pricing-source timestamp. The execution request must include the canonical payload digest and the same idempotency key used by the fiat and custody legs.

### 4.3 Custody adapter

```go
type CustodyProvider interface {
    AllocateDepositAddress(context.Context, DepositAddressRequest) (DepositAddress, error)
    CreateTransfer(context.Context, CustodyTransferRequest) (CustodyTransfer, error)
    QueryTransfer(context.Context, CustodyQuery) (CustodyTransfer, error)
    FreezeAsset(context.Context, FreezeRequest) error
}
```

The custody adapter must enforce network allowlists, destination allowlists, withdrawal limits, approval thresholds, travel-rule references, and HSM-backed signing. A successful custody response without a provider transfer ID or broadcast transaction hash is invalid.

### 4.4 Blockchain finality adapter

```go
type FinalityProvider interface {
    ObserveTransaction(context.Context, TransactionObservationRequest) (TransactionObservation, error)
    GetFinality(context.Context, FinalityRequest) (FinalityObservation, error)
    GetBlockStatus(context.Context, BlockStatusRequest) (BlockStatus, error)
}
```

The adapter must return `observed`, `confirmations`, `required_confirmations`, `block_hash`, `transaction_hash`, `chain_id`, `reorg_detected`, and `finality_status`. A transaction cannot be treated as settled until the configured finality policy passes and no reorganization or chain identity mismatch exists.

## 5. Settlement state machine

Each onramp/offramp uses a coordinator-owned state machine:

```text
CREATED
  → QUOTED
  → COMPLIANCE_PENDING
  → COMPLIANCE_APPROVED
  → FIAT_PENDING
  → FIAT_CONFIRMED
  → ASSET_PENDING
  → CUSTODY_PENDING
  → BROADCAST
  → FINALITY_PENDING
  → SETTLED

Failure branches:
  any pre-submission state → BLOCKED | CANCELLED
  provider timeout after possible submission → UNKNOWN
  UNKNOWN → RECONCILIATION_PENDING
  failed before business effect → FAILED or safe rail failover
  failed after business effect → HOLD / REFUND_PENDING
  finality reorg → REORG_REVIEW / HOLD
```

Only the coordinator may advance states. Terminal decisions are write-once. A provider `UNKNOWN` response prohibits blind retry and prohibits switching rails until a read-only query proves non-submission or the original provider is reconciled.

## 6. Idempotency and payload binding

### 6.1 Identity tuple

The immutable identity tuple is:

```text
(payment_order_id,
 payment_leg_id,
 idempotency_key,
 direction,
 asset,
 fiat_currency,
 amount_minor,
 payload_sha256)
```

The tuple must be inserted before the first external submission using a PostgreSQL transaction. A second request with the same idempotency key but a different payload digest, amount, asset, direction, or payment leg must return `ErrIdempotencyConflict` and must not call any provider.

### 6.2 Cross-replica single flight

The database must provide the cross-replica lock. The coordinator should:

1. Insert the attempt with `prepared` status using `INSERT ... ON CONFLICT`.
2. Lock the existing row with `SELECT ... FOR UPDATE`.
3. Compare the complete identity tuple.
4. Return the prior result if a terminal decision exists.
5. Permit only one owner to transition `prepared` to `submitted`.
6. Use a lease token for long provider calls.
7. Revalidate the lease before writing the result.
8. Record `unknown` if ownership or outcome becomes ambiguous.

The in-memory keyed single-flight map is useful within one process but cannot be the production source of truth.

### 6.3 Provider idempotency

The exact same idempotency key must be sent to every provider that supports it. Provider-specific keys may be derived as:

```text
sha256("umoja:" + release_scope + ":" + idempotency_key + ":" + leg_kind)
```

The derived key must be stored alongside the provider reference. It must never contain a customer name, account number, or secret.

## 7. Reconciliation design

The reconciliation worker joins four authoritative views:

| Source | Required join key | Required evidence |
|---|---|---|
| PostgreSQL | Attempt ID and idempotency key | State, digest, actor, timestamps |
| Provider | Provider reference and idempotency key | Provider status and finality reference |
| Custody/blockchain | Transaction hash and chain ID | Broadcast, confirmations, reorg status |
| TigerBeetle | Payment leg and posting intent | Debit/credit status and reconciliation result |

A reconciliation result must be one of `settled`, `failed_without_effect`, `held_for_review`, or `unresolved`. `unresolved` keeps the payment fenced and creates a compliance/operations alert. No worker may convert `unresolved` into `settled` without an authoritative provider and finality observation.

## 8. Onramp flow

1. Create a quote with expiry, fees, spread, and source references.
2. Run KYC, sanctions, AML/CFT/CPF, source-of-funds, and beneficiary checks.
3. Reserve the order and create the immutable intent.
4. Initiate fiat collection with the bank/PSP/IMTO adapter.
5. Confirm fiat settlement using provider reference and account reconciliation.
6. Execute stablecoin acquisition or mint through the approved issuer/liquidity adapter.
7. Transfer or allocate the stablecoin through custody.
8. Observe blockchain transaction and wait for configured finality.
9. Post the internal ledger entry only after all required confirmations.
10. Emit customer status and immutable evidence.

At no point should a fiat debit be treated as a stablecoin credit merely because the debit request was accepted.

## 9. Offramp flow

1. Create a quote and validate expiry/fees/spread.
2. Verify the source wallet, Travel Rule data, sanctions, blockchain risk, and beneficiary.
3. Allocate or validate the deposit address and allowed chain.
4. Observe the incoming transaction until finality.
5. Credit a held internal balance only after finality, not on mempool observation.
6. Execute redemption or sale through the issuer/liquidity adapter.
7. Initiate bank/PSP/IMTO payout.
8. Confirm final fiat settlement and provider reference.
9. Post the final ledger entry and close the attempt.
10. If redemption or payout fails after asset receipt, hold funds and initiate the approved refund/recovery path; never silently reverse ledger state.

## 10. Security and compliance controls

The implementation must include mTLS or signed provider authentication, secret-manager injection, HSM-backed custody signing, certificate rotation, destination allowlists, velocity/amount limits, dual approval for high-value transfers, least-privilege service accounts, and complete actor/event logging.

The AML/CFT/CPF gate must run before every external leg and again when a material attribute changes, including beneficiary, asset, chain, provider, amount, or risk score. High-risk sanctions or wallet-screening results must block execution and create a case. Travel Rule evidence must be attached by URI and digest, not stored as raw sensitive payload.

## 11. Observability contract

Every lifecycle span should include only:

```text
trace_id
span_id
service.name
environment
tenant_id (pseudonymous)
intent_id (non-sensitive)
leg_kind
direction
asset
fiat_currency
provider_name
provider_status
finality_status
outcome
```

Never record raw payment payloads, wallet addresses, account numbers, KYC documents, API keys, tokens, or private keys.

Required metrics include:

- `stablecoin_settlement_attempts_total{direction,asset,provider,outcome}`.
- `stablecoin_settlement_unknown_total{direction,provider}`.
- `stablecoin_reconciliation_mismatch_total{provider,asset}`.
- `stablecoin_finality_wait_seconds{chain,asset}`.
- `stablecoin_provider_latency_seconds{provider,operation}`.
- `stablecoin_fiat_payout_failures_total{provider,currency}`.
- `stablecoin_custody_signing_failures_total{provider}`.
- `stablecoin_tenant_isolation_denials_total{tenant_scope}`.

Alertmanager must route critical settlement, finality, reconciliation, custody, and compliance alerts to the approved Novu bridge. Tempo receives traces; Prometheus evaluates metrics; Alertmanager routes notifications.

## 12. Resilience and rollback tests

The staging test suite must cover:

| Scenario | Expected control |
|---|---|
| Fiat provider timeout before acknowledgement | UNKNOWN or safe non-submission query; no duplicate debit. |
| Fiat provider timeout after possible debit | UNKNOWN; hold and reconcile; no automatic second debit. |
| Issuer quote expiry | Block execution; require a new quote and policy evaluation. |
| Issuer mint/redeem timeout | UNKNOWN; no forced settlement. |
| Custody signing outage | Hold; no unsigned or partially signed transfer. |
| Blockchain congestion | Remain finality-pending; apply configured timeout/escalation. |
| Chain reorganization | Revert finality claim to review/hold; reconcile before settlement. |
| Provider returns a mismatched transaction hash | Reject result; raise integrity alert. |
| PostgreSQL/TigerBeetle discrepancy | Fence settlement and open reconciliation incident. |
| Mixed tenant notification | Reject Novu batch; alert security; preserve redacted evidence. |
| Secondary rail request after primary UNKNOWN | Prohibit until non-submission is proven. |

## 13. Evidence required for 10/10

| Gate | Required evidence |
|---|---|
| Provider approval | Executed agreements, permissions, sandbox credentials, limits, contacts, and provider due diligence. |
| Fiat rail | Collection/payout staging transactions, webhook signatures, reconciliation, timeout, refund, and duplicate tests. |
| Custody | Address allocation, HSM ceremony, signing, withdrawal policy, freeze, rotation, and incident evidence. |
| Blockchain finality | Confirmation policy, chain allowlist, finality tests, congestion test, reorg test, and transaction evidence. |
| AML/CFT/CPF | Policy decisions, sanctions/wallet screening, Travel Rule, case escalation, MLRO review, and audit records. |
| Ledger | PostgreSQL/provider/custody/blockchain/TigerBeetle zero-discrepancy reconciliation. |
| Resilience | Provider outage, UNKNOWN, failover, rollback, DR, RTO/RPO, and recovery evidence. |
| Observability | Collector, Prometheus, Tempo, Alertmanager, Novu acknowledgement, trace continuity, and redaction evidence. |
| Governance | Immutable manifest, common release SHA, four distinct approvers, detached signatures, and independent E-09 review. |

## 14. Implementation sequence

The recommended sequence is:

1. Freeze product boundary and supported corridors/assets.
2. Complete the durable settlement-attempt store and state-transition repository.
3. Implement fiat, custody, and finality adapters behind injected interfaces.
4. Add webhook signature verification and provider-reference schemas.
5. Implement reconciliation and lease-loss handling.
6. Add AML/CFT/CPF and Travel Rule gates to every external leg.
7. Add OTel spans and metrics with redaction tests.
8. Run unit, contract, component, chaos, DR, and cross-replica tests.
9. Execute authorized staging with real provider sandboxes.
10. Build and sign E-04 through E-09 evidence.
11. Obtain four independent approvals against the same release SHA.
12. Seek formal regulatory and provider authorization before any restricted live pilot.

## Final readiness statement

This design can take the codebase from a **4.5/10 stablecoin readiness baseline to a potential 10/10 control architecture**, but the final score depends on implementation and operating evidence. The platform should not claim 10/10 until the providers are approved, live staging tests pass, reconciliation is independently reviewed, and the full cryptographic evidence bundle is signed.

## Repository anchors

- `services/payment-engine/multirail/failover.go`
- `services/payment-engine/internal/provider/stablecoin_multirail.go`
- `database/postgresql/0055_stablecoin_settlement_idempotency.sql`
- `apps/control-plane/server/stablecoinIssuerEvidence.ts`
- `services/reporting-analytics/src/umojaflowos_reporting/stablecoin_exposure.py`
- `assurance/otel_novu_regulatory_evidence_mapping.md`
- `docs/staging_authorization_and_chaos_remediation_runbook.md`
