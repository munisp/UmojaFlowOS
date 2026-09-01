# PostgreSQL Pool Configuration for Fabric Queue Workers

## Scope

This guide configures the PostgreSQL connection pool used by the Fabric attestation queue. PostgreSQL is the durable cross-replica work and idempotency authority. Fabric is an attestation-only dependency. A pool timeout, database partition, lease conflict, or queue saturation event must leave the operation pending or UNKNOWN; it must not bypass the queue or authorize settlement.

## Actual transaction model

The queue claim path uses `BeginTx(ctx, nil)`, selects one due row with `FOR UPDATE SKIP LOCKED`, updates it to `running` with an attempt count and lease token, and commits immediately. The transaction does not remain open while the worker waits for Fabric.

`MarkUnknown` and `MarkComplete` are conditional single-row updates that require the queue ID, attempt number, and lease token. A stale worker receives a lease-loss error and cannot overwrite a newer result.

Because the code does not provide an explicit `sql.TxOptions`, the transaction uses the PostgreSQL/session default, normally `READ COMMITTED`. Do not change the queue claim path to `SERIALIZABLE` without a contention benchmark: `SKIP LOCKED` plus a short claim transaction is the intended concurrency model.

## Required pool variables

The service composition should expose the following settings. Names may be mapped to the repository’s deployment convention, but they must be recorded in the release manifest.

```text
UMOJA_POSTGRES_MAX_OPEN_CONNS
UMOJA_POSTGRES_MAX_IDLE_CONNS
UMOJA_POSTGRES_CONN_MAX_LIFETIME
UMOJA_POSTGRES_CONN_MAX_IDLE_TIME
UMOJA_FABRIC_ADMISSION_LIMIT
UMOJA_FABRIC_QUEUE_WORKERS
UMOJA_FABRIC_QUEUE_LEASE_DURATION
UMOJA_FABRIC_QUEUE_POLL_INTERVAL
UMOJA_FABRIC_COMMIT_STATUS_TIMEOUT
```

The application must call `SetMaxOpenConns`, `SetMaxIdleConns`, `SetConnMaxLifetime`, and `SetConnMaxIdleTime` at startup. Startup should fail closed if the values are absent, non-positive where required, or inconsistent.

## Sizing formula

Let `R` be the number of payment-engine replicas, `W` the queue workers per replica, `A` the maximum number of non-queue application connections per replica, `H` the per-replica health/migration/reconciliation reserve, and `P` the PostgreSQL connection budget allocated to this service.

```text
queue_connection_demand = R × (W + A + H)
required_service_pool = queue_connection_demand × 1.25 headroom
```

The configured `MaxOpenConns` must not exceed the service’s database role and PostgreSQL instance budget. If the service shares a database with other services, reserve capacity for every role before setting the payment-engine pool.

The Fabric admission limit should normally be no greater than the queue worker count and should be lower than the available database pool after non-queue reservations. Admission limits protect Fabric and goroutines; they do not replace database pool limits.

## Starting profiles

These are controlled starting points for staging experiments, not universal production values.

| Profile | Replicas | Queue workers/replica | Non-queue reserve/replica | Health reserve/replica | Max open/replica | Max idle/replica |
|---|---:|---:|---:|---:|---:|---:|
| Small staging | 1 | 8 | 4 | 2 | 20 | 8 |
| Multi-replica staging | 2 | 16 | 6 | 2 | 32 | 16 |
| Production candidate | 4 | 32 | 8 | 4 | 56 | 28 |

The production-candidate profile permits 128 queue workers across four replicas, but it does not imply that Fabric can sustain 128 concurrent commits. The real limit is the smaller of the admission capacity, database capacity, and measured Fabric peer/orderer capacity.

## Recommended environment example

```bash
export UMOJA_POSTGRES_MAX_OPEN_CONNS=56
export UMOJA_POSTGRES_MAX_IDLE_CONNS=28
export UMOJA_POSTGRES_CONN_MAX_LIFETIME=30m
export UMOJA_POSTGRES_CONN_MAX_IDLE_TIME=5m
export UMOJA_FABRIC_QUEUE_WORKERS=32
export UMOJA_FABRIC_ADMISSION_LIMIT=24
export UMOJA_FABRIC_QUEUE_LEASE_DURATION=90s
export UMOJA_FABRIC_QUEUE_POLL_INTERVAL=250ms
export UMOJA_FABRIC_COMMIT_STATUS_TIMEOUT=30s
```

The 90-second lease is intentionally longer than the 30-second commit-status timeout. It leaves room for error classification and durable UNKNOWN transition. It must be increased only after measuring worst-case database and application scheduling delay; an excessively long lease slows recovery after worker loss.

## Pool behavior under contention

When all connections are busy, new queue workers must wait for a connection and honor their context deadline. A canceled waiter must not acquire a connection later and must not submit to Fabric outside the queue. The worker should expose pool wait duration and count context cancellations.

`MaxIdleConns` should be large enough to absorb normal bursts without reconnect churn but never exceed `MaxOpenConns`. `ConnMaxLifetime` and `ConnMaxIdleTime` should be shorter than infrastructure-side connection retirement windows to avoid synchronized expiration. Add jitter to application restart and worker schedules rather than allowing every replica to poll at the same instant.

The queue polling transaction should remain short. Never hold a PostgreSQL row lock during Fabric submission, commit waiting, reconciliation queries, or object-storage operations. Use a bounded poll loop, `SKIP LOCKED`, and backoff when no rows are due.

## Validation queries

Run these queries as a staging database operator during the 100-worker contention test:

```sql
SELECT state, count(*)
FROM fabric_attestation_queue
GROUP BY state
ORDER BY state;

SELECT count(*) AS active_leases,
       max(now() - updated_at) AS oldest_running_age
FROM fabric_attestation_queue
WHERE state = 'running';

SELECT wait_event_type, wait_event, count(*)
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY wait_event_type, wait_event
ORDER BY count(*) DESC;

SELECT mode, relation::regclass, count(*)
FROM pg_locks
WHERE NOT granted OR relation IS NOT NULL
GROUP BY mode, relation
ORDER BY count(*) DESC;
```

Record `pg_stat_activity`, pool wait metrics, queue claim duration, lease loss, and Fabric latency in the same evidence bundle. A passing test requires that pool exhaustion does not affect API health, no stale worker completes a lease, and all timed-out Fabric operations remain UNKNOWN until read-only reconciliation.

## Fail-closed limits

Set a maximum queue depth and maximum in-memory admission wait. When either limit is exceeded, return a held/backpressure response and retain the request’s durable idempotency identity. Do not create unbounded goroutines, extend deadlines indefinitely, or fall back to direct Fabric submission.
