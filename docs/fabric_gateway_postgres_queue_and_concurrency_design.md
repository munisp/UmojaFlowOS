# Fabric Gateway PostgreSQL Queue and Concurrency Admission Design

## Safety boundary

Fabric attestation is advisory evidence infrastructure. TigerBeetle remains authoritative for double-entry accounting, and PostgreSQL remains authoritative for settlement idempotency and durable UNKNOWN state. A Fabric timeout, partition, endorsement conflict, or digest mismatch must not authorize settlement or an automatic secondary submission.

## Queue schema

Migration `database/postgresql/0057_fabric_attestation_queue.sql` creates `fabric_attestation_queue`. The idempotency key is unique, release SHA and payload digest are format-checked, and the state machine is `pending -> running -> complete` or `pending -> running -> unknown -> running`. A running job carries a UUID lease token and expiry. An attestation ID is unique when present, and a complete row must have both an attestation ID and completion timestamp.

The due-item and expired-lease partial indexes support efficient polling without scanning terminal rows. Queue claiming must use a short PostgreSQL transaction with `FOR UPDATE SKIP LOCKED`; a worker never holds a row lock while waiting for Fabric.

## Go implementation

`services/payment-engine/internal/attestation/queue.go` provides:

- Idempotent `Enqueue`, returning `created=false` for an existing key.
- Atomic `Claim` with attempt increment, UUID lease token, and bounded lease duration.
- Lease-checked `MarkUnknown` for timeout, partition, or inconclusive provider results.
- Lease-checked `MarkComplete` requiring a non-empty Fabric attestation ID.
- `AdmissionController`, a process-local semaphore that bounds concurrent Gateway calls and returns context cancellation to callers waiting for capacity.

The in-memory admission limit is deliberately complementary to the PostgreSQL queue. PostgreSQL prevents duplicate work across replicas; the semaphore protects each process from unbounded Gateway goroutines and commit waits.

## Timeout and UNKNOWN flow

1. The API validates the request and computes the evidence digest.
2. The request is inserted with its idempotency key. A duplicate enqueue returns the existing work identity and does not create a second queue item.
3. A worker acquires an admission slot, claims one due queue row, and submits through `SubmitWithContext`.
4. A committed Fabric response is bound to release SHA, evidence ID, digest, and attestation ID before marking complete.
5. A caller or commit-status timeout marks the row `unknown`, releases the lease, and schedules a read-only reconciliation attempt. It never performs a blind duplicate submission.
6. Reconciliation queries Fabric under a new lease. A confirmed record is recorded as provider-accepted with `settlement_allowed=false`. An explicitly confirmed no-business-effect result remains non-authoritative and requires a separate approved execution command before any retry.
7. Lease loss is a hard error. The worker must not mark complete, submit a secondary transaction, or overwrite another worker’s decision.

## Capacity sizing

The practical in-flight bound is:

```text
maximum in-flight Fabric calls = min(process admission limit × replicas, downstream Fabric capacity)
```

The 30-second commit timeout is a ceiling on slow commit-status waits, not a normal request delay. Queue and admission settings should be selected from measured Fabric p95/p99 commit latency, peer/orderer capacity, and the accepted maximum UNKNOWN backlog. If the queue reaches its configured bound, new work must remain pending or be held; it must not bypass the queue through an unbounded synchronous path.

## Test suite

Run local safety and race tests:

```bash
scripts/infra/run_fabric_attestation_integration.sh
```

Run the deterministic 100-concurrent commit/MVCC simulation:

```bash
cd services/payment-engine
GO_BIN=/home/ubuntu/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.25.4.linux-amd64/bin/go
$GO_BIN test ./internal/attestation -run TestFabricCommitLatencyAndMVCCConflictSimulation100Concurrent -count=1 -v
```

The simulation uses a single deterministic attestation key, a 5 ms synthetic commit delay, and 100 concurrent submissions. It expects exactly one successful commit and 99 MVCC-style conflicts. This validates the safety shape of duplicate handling; only a real multi-peer Fabric channel can establish production commit latency and actual MVCC rates.

## Production controls

Use a durable PostgreSQL-backed queue, a bounded admission limit, a circuit breaker for repeated Fabric failures, and a separate reconciliation worker pool. Export queue depth, claim age, lease loss, UNKNOWN age, submit latency, commit latency, conflict counts, and reconciliation outcomes with tenant-safe labels. Do not place raw evidence or private keys in queue rows or telemetry.

The production gate requires a real Fabric network with independent organizations, approved endorsement policy, HSM-backed identities, a tested orderer/peer topology, partition and commit-timeout evidence, PostgreSQL migration verification, and immutable evidence binding for every decision.
