# PostgreSQL Tuning for Retention-Worker Row-Level Lock Contention

## Scope and safety position

The retention worker uses a PostgreSQL authorization row to enforce exactly-once execution. Contention on **one decision digest** is expected in the Locust single-digest profile: one caller wins and concurrent callers must be rejected as replay attempts. The objective is not to remove that serialization; it is to keep the critical transaction short, bound excessive waiting, and protect unrelated database workloads.

> PostgreSQL row-level locks block conflicting writers and lockers to the same row, and they are normally released at transaction end. [1]

Do not weaken the authorization claim by replacing it with an eventually consistent cache, a process-local lock, or `SKIP LOCKED` for a single requested decision digest. Any tuning change must preserve one successful claim and zero duplicate executions.

## 1. Establish a baseline before changing settings

Run the unique-digest and contention Locust profiles with a fixed image digest, fixed user count, fixed PostgreSQL resource class, and a recorded configuration snapshot. Measure worker p95/p99 latency, PostgreSQL maximum lock wait, lock-wait session count, authorization outcomes, and database CPU/IO.

| Signal | Why it matters | Query or source |
|---|---|---|
| Worker claim latency | Shows end-to-end user-facing impact | `umoja_retention_worker_execution_seconds_bucket` |
| Maximum lock wait | Detects blocked authorization claims | `pg_retention_lock_wait_max_wait_seconds` |
| Waiting sessions | Detects queue depth | `pg_retention_lock_wait_waiting_sessions` |
| Replay outcomes | Expected in the contention profile | `umoja_retention_worker_results_total{result="denied_replay_or_consumed"}` |
| Deadlocks | Indicates conflicting lock order elsewhere | PostgreSQL logs and `pg_stat_database.deadlocks` |
| Pool saturation | Detects connection pressure disguised as lock pressure | PgBouncer / PostgreSQL exporter |

## 2. Keep the authorization transaction minimal

The current path should contain only the authorization claim: no OpenSearch request, WORM lookup, HTTP call, filesystem operation, or human approval inside the PostgreSQL transaction. Commit the claim before performing the OpenSearch identity recheck and deletion.

For a single immutable decision digest, prefer a conditional update that acquires the row lock and claims it atomically:

```sql
UPDATE retention_delete_authorizations
SET consumed_at = now(),
    execution_status = 'claimed'
WHERE decision_digest = $1
  AND consumed_at IS NULL
  AND expires_at > now()
  AND expires_at = $2
RETURNING decision_digest;
```

A returned row means the worker owns the claim. No returned row means the authorization is missing, expired, or already consumed. This can reduce round trips compared with a separate read and update while retaining PostgreSQL’s row-level write lock semantics. Validate the exact expiry comparison and replay semantics in staging before changing the production query.

## 3. Bound waits at the role/session level

Apply limits to the `retention_worker_app` login only, not globally. This prevents one stalled claim from occupying a connection indefinitely while preserving the database-wide defaults for other services.

```sql
ALTER ROLE retention_worker_app IN DATABASE umoja
  SET lock_timeout = '1500ms';

ALTER ROLE retention_worker_app IN DATABASE umoja
  SET statement_timeout = '5s';

ALTER ROLE retention_worker_app IN DATABASE umoja
  SET idle_in_transaction_session_timeout = '10s';
```

A lock timeout should map to a retriable worker result such as `database_lock_timeout`; it must not be interpreted as authorization approval or trigger a blind delete retry. Start with an intentionally conservative staging threshold below the two-second operational alert threshold, then adjust only after observing real p95/p99 claim times.

`deadlock_timeout` is not a throughput knob. PostgreSQL waits for this duration before performing deadlock detection; its default is one second, and shorter values can be useful temporarily while investigating lock delays when paired with `log_lock_waits`. [2]

```sql
-- Time-bound staging diagnosis only; requires appropriate privileges.
ALTER SYSTEM SET log_lock_waits = on;
ALTER SYSTEM SET deadlock_timeout = '200ms';
SELECT pg_reload_conf();
```

Do not carry a reduced `deadlock_timeout` into production permanently without measuring logging and CPU overhead.

## 4. Control concurrency with a transaction pool

Use PgBouncer in **transaction pooling** mode or a bounded application connection pool for the retention worker. Set the worker pool size below the PostgreSQL capacity allocated to this workload; increase user-level Locust concurrency independently from database connections.

A practical staged starting point is a small pool—such as 10 to 20 database connections per worker deployment—followed by measurement. The correct value depends on CPU, storage latency, other workloads, and the ratio of unique to contended authorizations. More connections do not resolve a hotspot on one row; they can increase queued work and context switching.

| Setting | Intended effect | Guardrail |
|---|---|---|
| Worker pool maximum | Bounds simultaneous claim transactions | Start low, raise only when PostgreSQL is not CPU/IO or lock constrained |
| PgBouncer transaction mode | Reuses connections after each short transaction | Do not use session-required features in the claim path |
| `lock_timeout` | Fails blocked claims predictably | Treat SQLSTATE `55P03` as retriable and fail closed |
| `statement_timeout` | Bounds total database work | Keep above normal p99 but below worker HTTP timeout |
| `idle_in_transaction_session_timeout` | Removes leaked transaction locks | Set per worker role; monitor disconnects |

## 5. Index and schema hygiene

The primary key on `decision_digest` is required for a selective claim lookup. Keep the existing partial index on unconsumed authorization expiry for reconciliation and expiry jobs. Run `ANALYZE` after meaningful load-test fixture creation so the planner has current statistics.

```sql
ANALYZE retention_delete_authorizations;

SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
FROM pg_stat_user_indexes
WHERE relname = 'retention_delete_authorizations';
```

Do **not** raise `max_locks_per_transaction` to solve row contention. PostgreSQL documents that it sizes object-lock capacity and is not the number of rows that can be locked. [2]

## 6. Isolation level and retry behavior

The claim is a single-row, conditional state transition. In most cases, `READ COMMITTED` plus the atomic conditional update is appropriate because PostgreSQL evaluates the statement against the current committed row and serializes conflicting updates. [3]

Do not enable `SERIALIZABLE` solely to optimize a single-row claim. Serializable transactions can require whole-transaction retries after SQLSTATE `40001`, and PostgreSQL recommends controlling active connections and keeping transactions small when using that isolation level. [3]

If business logic expands to read multiple related records before claiming, assess whether serializable isolation is needed. If it is, implement bounded full-transaction retries with jitter and idempotent correlation IDs.

## 7. Deadlock prevention

The current worker should lock at most one authorization row. If a future workflow needs several rows, acquire them in a deterministic order, such as sorted `decision_digest`. PostgreSQL advises consistent lock ordering as the primary defense against deadlocks. [1]

Never hold an authorization-row lock while requesting OpenSearch, an archive provider, or a remote approval system. Those calls can be slow or partitioned, which increases lock duration and deadlock risk.

## 8. Staged change procedure

1. Capture a baseline using the Locust unique and contention profiles.
2. Apply role-specific timeout settings in staging.
3. Deploy worker handling for lock-timeout SQLSTATEs and verify it fails closed.
4. Run the canary, unique profile, and contention profile at the same concurrency ladder.
5. Compare the weekly Prometheus report with the approved baseline.
6. Roll back the role settings if p95/p99 latency, lock waits, or timeout rate regresses.
7. Obtain service-owner, database-owner, and security-owner approval before production rollout.

## 9. Rejection conditions

Do not promote a tuning change if any of the following occurs:

- more than one successful claim for the contention decision digest;
- any unauthorized OpenSearch deletion;
- any ambiguous authorization status after a timeout;
- nonzero security authentication/authorization failures;
- lock waits remain above two seconds under the approved regression load; or
- database resource saturation causes impact to non-retention workloads.

## References

[1]: https://www.postgresql.org/docs/current/explicit-locking.html "PostgreSQL Documentation — Explicit Locking"
[2]: https://www.postgresql.org/docs/current/runtime-config-locks.html "PostgreSQL Documentation — Lock Management"
[3]: https://www.postgresql.org/docs/current/transaction-iso.html "PostgreSQL Documentation — Transaction Isolation"
