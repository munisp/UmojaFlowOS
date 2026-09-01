# Payment-Engine UNKNOWN Transaction Disaster-Recovery and State-Reconciliation Playbook

## Purpose and non-negotiable rule

This playbook governs payment and Fabric-attestation work that cannot be conclusively classified as committed or not committed. An `UNKNOWN` result is an ambiguity boundary, not a failure that may be retried freely.

> **Fail-closed rule:** If the provider, Fabric network, database, object store, signer, or reconciliation evidence is ambiguous, hold the transaction and prohibit blind resubmission.

The PostgreSQL queue remains the durable work and lease authority. TigerBeetle remains the authoritative double-entry ledger. Fabric is an attestation layer. An operator must never infer financial settlement from a Fabric timeout, and must never infer non-commit merely because a client did not observe a commit event.

## State model

| State | Meaning | Permitted action | Prohibited action |
|---|---|---|---|
| `pending` | Durable item has not been claimed | Claim under `FOR UPDATE SKIP LOCKED` | Duplicate claim or direct provider submit outside the queue |
| `running` | Replica owns a lease and is processing | Read evidence, submit once, or perform the designated read-only reconciliation | Continue after lease expiry or submit from a stale worker |
| `unknown` | Outcome cannot be proven | Read-only query, evidence binding, operator review, and lease-controlled transition | Blind retry, automatic alternate-rail submission, or ledger posting based on assumption |
| `complete` | Verified terminal attestation exists | Audit and retention operations | Mutation, re-execution, or deletion |

Every transition must retain the queue ID, idempotency key, attempt number, lease token, release SHA, evidence ID, payload digest, provider/Fabric correlation ID, timestamps, and reason.

## Detection and severity

Declare an incident when UNKNOWN depth increases continuously for five minutes, any UNKNOWN item exceeds its reconciliation age threshold, a lease expires while a worker is still active, a digest mismatch is observed, or object-storage/Vault failures prevent evidence retrieval. Escalate immediately when the affected item is linked to a customer payment, a ledger posting, a regulatory report, or a WORM evidence package.

| Severity | Trigger | Initial owner | Containment objective |
|---|---|---|---|
| SEV-1 | Evidence of duplicate submission, ledger ambiguity, or broad Fabric partition | Incident commander and MLRO | Freeze new execution and preserve all records |
| SEV-2 | Queue-wide UNKNOWN growth, expired credentials, or repeated commit timeouts | Payment-engine lead | Stop ambiguous processing and restore read-only visibility |
| SEV-3 | Isolated item with bounded retryable infrastructure error | Queue operator | Hold item, repair dependency, reconcile safely |

## Immediate containment

First freeze the affected execution path using the deployment feature flag or circuit breaker. Do not delete queue rows, clear leases manually, or restart every replica before preserving logs and database state. Capture the deployment digest, configuration checksum, active replica list, queue counts, database pool statistics, Fabric endpoint identity, object-storage endpoint, Vault secret version, and the current alert payload.

Next, confirm that TigerBeetle and PostgreSQL agree on the financial transaction state. If the ledger state is not conclusively known, stop all related settlement execution and escalate to the MLRO and incident commander. Fabric attestation recovery must not be used to force a ledger decision.

## Evidence preservation

Create an immutable incident bundle containing a PostgreSQL snapshot of affected queue rows, transaction and lock observations, payment-engine logs, Envoy/Fabric Gateway logs, OTel trace identifiers, object-store access errors, Vault audit events, deployment manifests, image digest/signature evidence, and operator actions. Hash the bundle before upload and require independent approval for WORM retention.

The bundle must exclude secret values, private keys, access tokens, raw payment credentials, and unrestricted customer payloads. Store references and digests instead of copying sensitive content into incident channels.

## Safe reconciliation procedure

1. Identify the queue row by idempotency key and verify that the release SHA, evidence ID, URI, payload digest, and endorsement scope match the originating request.
2. Acquire the row using the normal lease protocol. A stale lease must be reclaimed only after `lease_until` has expired and the claim transaction has succeeded.
3. Derive the deterministic Fabric attestation ID from the release SHA, evidence ID, and evidence digest. Do not generate a new identity for a retry.
4. Perform a read-only Fabric lookup with a bounded context. Verify the returned attestation ID, release SHA, evidence ID, evidence digest, evidence URI, and endorsement scope.
5. If all bindings match, mark the queue item complete under the current lease. This is reconciliation, not a second submission.
6. If the lookup returns a transport error, timeout, malformed record, missing record, or binding mismatch, keep the item UNKNOWN, record the reason, release the lease, and schedule another read-only reconciliation attempt.
7. If an operator wants to re-authorize a submission after conclusive proof that no commit exists, require a new dual-control decision, a fresh attempt record, and an explicit transition approved by the release policy. Never implement this by silently changing UNKNOWN to pending.

## Lease and replica recovery

A worker that loses its lease must stop processing immediately. Its `MarkUnknown` or `MarkComplete` update must affect zero rows and return `ErrQueueLeaseLost`. The stale worker must not issue another Fabric request. The next replica may reclaim the row only through the queue’s expired-lease predicate.

Run the following checks before enabling reconciliation:

```sql
SELECT id, idempotency_key, state, attempts, lease_token, lease_until,
       attestation_id, last_error, updated_at
FROM fabric_attestation_queue
WHERE state = 'unknown'
   OR (state = 'running' AND lease_until < now())
ORDER BY updated_at;

SELECT state, count(*)
FROM fabric_attestation_queue
GROUP BY state;
```

Compare the results across replicas through Prometheus queue-depth metrics and the authoritative PostgreSQL query. Any divergence between local gauges and PostgreSQL is an observability incident and must not be interpreted as queue clearance.

## Dependency-specific recovery

| Dependency failure | Safe response |
|---|---|
| Fabric peer/orderer partition | Hold submission outcomes as UNKNOWN; use read-only query after recovery; do not submit a duplicate |
| Vault rotation failure | Freeze new evidence retrieval and signing; retain current valid version only if its validity is proven; otherwise hold work |
| Expired object-storage credentials | Do not upload or accept partial evidence; mark affected jobs UNKNOWN or held; rotate credentials through the approved secret manager and revalidate with a harmless read |
| Object digest mismatch | Quarantine the item, preserve both expected and observed digests, and require compliance review |
| PostgreSQL pool exhaustion | Apply backpressure, preserve queued rows, and do not bypass the queue with direct execution |
| Database lock contention | Observe `pg_stat_activity` and `pg_locks`; do not terminate transactions without incident-commander approval |
| OTel/Prometheus outage | Preserve the transaction safety boundary; restore telemetry before declaring recovery complete |

## Recovery exit criteria

The incident may move from containment to recovery only when the dependency health checks pass, pool wait and lock metrics are normal, no stale worker retains an active lease, all affected UNKNOWN rows have a read-only reconciliation outcome or an approved hold disposition, and no duplicate external submission occurred.

Before unfreezing execution, obtain independent approval from engineering, compliance/MLRO, operations, and release governance. Record the exact image digest, configuration versions, Vault secret version, object-storage credential validation result, queue counts, and reconciliation report in the signed evidence manifest.

## Post-incident review

Within one business day, reconcile the queue, TigerBeetle ledger, provider records, Fabric records, and WORM evidence inventory. Determine whether any outcome was duplicated, omitted, delayed, or incorrectly classified. Add regression tests for the triggering failure, update alert thresholds, and record corrective actions with owners and expiry dates.

## Production gates

The playbook is not a substitute for live evidence. Production approval requires a real PostgreSQL contention test, a multi-peer Fabric partition test, credential rotation and revocation evidence, object-store retention verification, OTel trace continuity, alert-routing evidence, and independent sign-off of the immutable incident bundle.
