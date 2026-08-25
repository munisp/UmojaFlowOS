# Staging TigerBeetle client and failover verification runbook

## Safety boundary

Run this only against an isolated, non-production TigerBeetle cluster and non-production PostgreSQL database. The test creates real accounts and transfers in the selected staging ledger. Do not reuse production cluster IDs, account IDs, transfer IDs, credentials, or endpoints.

## Client configuration

Provision values through the staging secret manager or protected workload environment:

```text
UMOJA_TIGERBEETLE_ENABLED=true
UMOJA_TIGERBEETLE_CLUSTER_ID=<nonzero-staging-cluster-id>
UMOJA_TIGERBEETLE_ADDRESSES=<private-address-1>,<private-address-2>,<private-address-3>
UMOJA_TIGERBEETLE_NGN_LEDGER=<staging-ngn-ledger>
UMOJA_TIGERBEETLE_KES_LEDGER=<staging-kes-ledger>
UMOJA_TIGERBEETLE_ZAR_LEDGER=<staging-zar-ledger>
UMOJA_TIGERBEETLE_ACCOUNT_CODE=<approved-account-code>
UMOJA_TIGERBEETLE_TRANSFER_CODE=<approved-transfer-code>
UMOJA_TIGERBEETLE_TLS_REQUIRED=true
UMOJA_TIGERBEETLE_ALLOW_INSECURE_LOOPBACK=false
UMOJA_TIGERBEETLE_FAIL_CLOSED=true
```

The Go adapter validates nonzero IDs, distinct currency ledgers, private/reachable addresses, and encrypted transport policy before constructing the official client. The official client is created once and shared; it is not a per-request connection pool. TigerBeetle’s Go client internally manages concurrent requests and batching, so callers should reuse one client instance and submit batches rather than opening one client per transaction.

## Run the opt-in staging suite

The suite is in:

```text
services/payment-engine/internal/ledger/staging_integration_test.go
```

It refuses to run without both explicit gates:

```bash
export TIGERBEETLE_STAGING_INTEGRATION=true
export TIGERBEETLE_STAGING_APPROVED=true
```

Set the private staging endpoint and nonzero values:

```bash
export TIGERBEETLE_STAGING_ADDRESS='tb-replica-proxy.staging.internal:3000'
export TIGERBEETLE_STAGING_CLUSTER_ID='<cluster-id>'
export TIGERBEETLE_STAGING_ACCOUNT_CODE='<account-code>'
export TIGERBEETLE_STAGING_TRANSFER_CODE='<transfer-code>'
export TIGERBEETLE_STAGING_NGN_LEDGER='<ngn-ledger>'
export TIGERBEETLE_STAGING_TLS_REQUIRED=true
export TIGERBEETLE_STAGING_ALLOW_INSECURE_LOOPBACK=false
```

Run:

```bash
cd services/payment-engine
go test ./internal/ledger -run TestStagingOfficialTigerBeetleBatchPrimitives -count=1 -v
```

The test uses the repository’s real `NewTigerBeetleClient`, not a mock. It validates configuration, connects to the selected cluster, creates three history accounts in one batch, creates two transfers in one batch, and resubmits the same transfer IDs. The second submission must be idempotent and return `exists` through the adapter rather than create another transfer.

## Failover verification procedure

### 1. Establish a baseline

Record the staging cluster ID, replica IDs, replica addresses, software version, ledger numbers, and current database reconciliation watermark. Capture the current TigerBeetle and payment-engine health metrics. Confirm that no production DNS, credentials, or customer data are present.

### 2. Freeze new submissions

Set the payment-engine transaction gate to maintenance/frozen mode. Existing in-flight calls must be treated as indeterminate until their deterministic transfer IDs are checked. Confirm that new payment requests receive a retryable maintenance response and that no new transfer IDs are generated during the test.

### 3. Inject one-replica loss

Stop or isolate one staging replica using the approved orchestration mechanism. Do not use an unreviewed shell command on a production host. For a quorum-backed cluster, the remaining replicas should continue only if quorum remains available. Record the exact UTC start time and replica identity.

Expected result: health monitoring records degraded capacity, but the authoritative cluster remains single-writer and does not expose two independent writable primaries.

### 4. Inject a network partition

Use the staging network policy or service-mesh fault injector to isolate the selected replica from the other replicas while preserving administrative access. Verify that the isolated replica cannot accept authoritative writes. Do not resume application traffic solely because a local TCP port remains open.

Expected result: the application or DR controller remains `indeterminate` unless authoritative quorum, cluster identity, and fencing are verified.

### 5. Test interrupted transfer semantics

Start one controlled transfer with a deterministic transfer ID, interrupt the client path after submission, and do not create a new ID. After quorum is restored, retry the exact same transfer ID. Accept only `created` or idempotent `exists`; then retrieve the confirmed fact through the approved operational path and compare it with the PostgreSQL intent.

A timeout is never evidence that the transfer did not happen. A duplicate with different fields must be rejected as an integrity incident.

### 6. Test old-primary fencing and split-brain prevention

Before any promotion, prove that the old primary is fenced from client traffic and cannot accept writes. Prove that only one cluster identity is writable. If two writable primaries or divergent cluster identities are visible, stop the test and keep payments frozen.

The DR controller’s required order is:

```text
freeze → fence old primary → verify quorum/identity → promote one writer
→ reconcile in-flight IDs → run PostgreSQL reconciliation → resume
```

### 7. Run PostgreSQL reconciliation

Run the controlled reconciliation job over the outage window:

```bash
AUDIT_DATABASE_URL='postgresql://<auditor>@<private-db>:5432/<db>?sslmode=verify-full' \
RECONCILIATION_SOURCE_IDENTITY='staging-dr-reconciliation' \
WINDOW_START='<outage-start-utc>' \
WINDOW_END='<recovery-end-utc>' \
RUN_REFERENCE='staging-dr-<incident-id>' \
  bash scripts/infra/reconcile_tigerbeetle_postgres.sh
```

Expected clean result:

```text
reconciliation_status=reconciled
```

Any missing fact, unexpected fact, or field mismatch must produce a nonzero exit and remain `discrepancy`. Database/API failure must produce `indeterminate`. Do not resume payments on either result.

### 8. Resume and observe

Resume traffic only after the change owner approves the evidence bundle: fencing proof, quorum proof, cluster identity, transfer results, reconciliation output, metrics, logs, and incident timeline. Observe duplicate-transfer rate, reconciliation discrepancy count, timeout rate, and payment lifecycle transitions for the agreed soak period.

## Abort criteria

Abort immediately and keep transaction processing frozen if any of the following occurs: two writable primaries are observed; cluster ID or replica identity is ambiguous; an interrupted transfer cannot be resolved by its original ID; PostgreSQL and TigerBeetle facts disagree; the reconciliation job is indeterminate; the old primary is not fenced; or the new path cannot prove private authenticated transport.

## Evidence requirements

Retain the command output, UTC timestamps, cluster/replica identities, transfer IDs, PostgreSQL run reference, discrepancy rows, metrics snapshots, Wazuh/SIEM events, and operator approvals in the independent evidence store. Simulated state-machine tests and local plan-mode output are useful engineering evidence but are not proof of live TigerBeetle failover or regulatory readiness.
