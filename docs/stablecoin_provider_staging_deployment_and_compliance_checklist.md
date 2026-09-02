# Stablecoin Provider Staging Deployment Runbook and Compliance Checklist

## Scope

This runbook covers authorized staging connection of three provider classes required for stablecoin onramp/offramp readiness:

1. A regulated Nigerian bank, PSP, or IMTO for fiat collection and payout.
2. An approved custody or wallet provider for address allocation, signing, broadcast, and withdrawal controls.
3. An approved blockchain data/finality provider for transaction observation, confirmation depth, chain identity, and reorganization detection.

No provider may access production accounts, production wallets, production topics, or customer funds during this procedure. The protected execution gates are `STAGING_EVIDENCE_APPROVED=CAPTURE_APPROVED_STAGING_EVIDENCE` and `CHAOS_APPROVED=EXECUTE_APPROVED_STAGING_CHAOS`; both must remain unset until the required approvers authorize the specific staging run.

## Preconditions

The release manager must record the immutable release SHA, image digests, migration checksums, provider sandbox approval, provider contract/permission record, test tenant, supported corridors/assets, and evidence destination. The Security Owner must confirm secret-manager injection, mTLS or signed authentication, egress allowlists, and no raw credentials in logs. The Compliance Owner/MLRO must approve KYC/AML/CFT/CPF, sanctions, Travel Rule, source-of-funds, and beneficiary test data. The Operations Owner must confirm rollback, monitoring, on-call, and reconciliation readiness.

## Provider onboarding checklist

| Control | Bank/PSP/IMTO | Custody | Blockchain finality | Evidence |
|---|---:|---:|---:|---|
| Legal entity and contract verified | Required | Required | Required | Signed agreement and due diligence record |
| Regulatory permission verified | Required | Required | Required where applicable | Licence/permission evidence |
| Sandbox endpoint isolated | Required | Required | Required | Endpoint and network policy |
| mTLS or signed authentication | Required | Required | Required | Certificate/key reference and rotation test |
| Credential injected from secret manager | Required | Required | Required | Secret access audit, no secret value |
| Idempotency supported | Required | Required | Required | Provider request/response contract |
| Read-only status lookup | Required | Required | Required | Query test and status mapping |
| Webhook signature validation | Required | Recommended | Recommended | Valid/invalid signature tests |
| Rate and amount limits | Required | Required | Required | Configuration and enforcement test |
| Timeout/UNKNOWN semantics | Required | Required | Required | Failure-path test |
| Reconciliation reference | Required | Required | Required | Provider/reference/hash mapping |

## Deployment sequence

### 1. Deploy configuration

Inject only staging values through the secret manager:

```text
FIAT_PROVIDER_BASE_URL
FIAT_PROVIDER_CLIENT_CERT_REF
FIAT_PROVIDER_CA_REF
CUSTODY_PROVIDER_BASE_URL
CUSTODY_PROVIDER_CLIENT_CERT_REF
BLOCKCHAIN_FINALITY_BASE_URL
BLOCKCHAIN_CHAIN_ALLOWLIST
STABLECOIN_SUPPORTED_ASSETS
STABLECOIN_SUPPORTED_FIAT
```

Set provider names, environment, service identity, OTLP endpoint, and tenant scope through non-secret configuration. Reject startup if any required endpoint is missing, non-HTTPS outside an explicitly approved loopback test, or points to a production hostname.

### 2. Run connectivity checks

For each provider, verify TLS chain, service identity, health endpoint, clock skew, and expected API version. A health response does not prove authorization or settlement capability; retain it only as connectivity evidence.

### 3. Run contract tests

Execute the provider adapter tests for valid request, invalid asset/currency, expired quote, duplicate idempotency key, mismatched payload digest, timeout, malformed response, non-2xx response, missing provider reference, signed webhook, invalid webhook, and read-only query.

### 4. Run controlled onramp

Use a synthetic tenant and provider sandbox funds. The test must create a quote, execute policy/AML checks, initiate a bank debit, confirm fiat settlement, acquire stablecoin, allocate custody, observe blockchain finality, and post the internal ledger entry only after all required references are present.

### 5. Run controlled offramp

Use a synthetic wallet and approved chain. Observe an incoming transaction through finality, pass compliance checks, debit or redeem through custody/issuer, initiate bank payout, confirm payout settlement, and reconcile the provider reference, blockchain hash, custody record, PostgreSQL attempt, and TigerBeetle posting.

## Mandatory failure tests

| Failure | Required outcome |
|---|---|
| Bank timeout after request transmission | `UNKNOWN`; no blind retry; query/reconcile. |
| Bank duplicate request | Provider and database idempotency prevent second debit. |
| Custody signing failure | No broadcast; attempt held. |
| Custody returns missing transaction hash | Result rejected. |
| Blockchain provider stale data | Finality remains pending; no settlement. |
| Chain reorganization | Finality revoked; attempt held for review. |
| Wrong chain/network | Reject and raise integrity alert. |
| Provider payload digest mismatch | Reject before ledger posting. |
| PostgreSQL replica lag | Stale read cannot authorize a second submission. |
| Split-brain writer | Fencing rejects non-authoritative terminal decision. |
| AML/sanctions hit | Block external execution and create case. |
| Novu mixed-tenant payload | Reject notification batch and create security event. |

## Reconciliation acceptance

The run passes only when every successful transaction has matching records in PostgreSQL, the provider, custody, blockchain finality source, and TigerBeetle. There must be zero unexplained discrepancies, zero duplicate provider submissions, zero unbounded UNKNOWN records, and no ledger edit performed outside the approved state machine.

## Compliance verification checklist

Before recommending GO, the Compliance Owner verifies that the provider is approved for the corridor and service, the customer and beneficiary controls execute before each external leg, sanctions and wallet screening are fail-closed, Travel Rule evidence is captured, high-risk activity escalates to a case, retention/WORM storage is working, audit events contain actor/time/reference/digest, and tenant isolation has passed mixed-tenant and missing-tenant tests.

The Security Owner verifies least-privilege roles, certificate rotation, HSM signing, secret redaction, network policy, dependency/SBOM review, vulnerability findings, and alert delivery. The Operations Owner verifies dashboards, SLOs, alert routes, runbooks, DR, restore, rollback, and on-call acknowledgement. The Release Manager verifies all artifacts reference one release SHA and are hashed in the manifest.

## Evidence package

The staging bundle must include provider approvals, endpoint and certificate references, request/response contract logs with sensitive fields redacted, quote evidence, fiat references, custody references, blockchain transaction hashes, finality observations, AML decisions, reconciliation reports, OTel trace IDs, Prometheus samples, Alertmanager notifications, Novu acknowledgements, rollback logs, and independent witness statements.

E-04 requires ledger and provider execution proof. E-05 requires compliance and transaction-monitoring proof. E-06 requires controlled failure/recovery and reconciliation proof. E-07 requires security/operational controls. E-08 requires resilience, monitoring, and recovery proof. E-09 requires the immutable manifest, four distinct approvals, detached signatures, and independent review.

## Rollback and exit

On any failed test, stop settlement, preserve the attempt as `UNKNOWN` or `HELD`, revoke temporary provider credentials if required, remove test data only through the approved retention procedure, remove network faults, and open a CAP record. Never delete or rewrite evidence to make a failed test pass.

The deployment is eligible for external reassessment only after all failures have a disposition, every required live test has a retained digest, the evidence bundle is stored immutably, and the four independent approvers sign the same release SHA.
