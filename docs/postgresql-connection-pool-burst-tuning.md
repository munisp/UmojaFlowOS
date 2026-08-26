# PostgreSQL Connection-Pool and Timeout Tuning for Retention Burst Workloads

## Objective

This guide tunes the **retention delete worker** for bursty authorization-claim traffic without weakening exactly-once claim semantics, database role separation, manifest verification, legal holds, or the fail-closed circuit breaker. It applies only to the dedicated PostgreSQL worker role and its connection pool; it does not recommend global PostgreSQL defaults as a first response to saturation.

> A larger pool is not an automatic performance improvement. It increases concurrent demand placed on PostgreSQL. Set a bounded worker pool only after accounting for all services, administrative reserves, and observed transaction duration.

## Implemented worker defaults

The worker now establishes pooled PostgreSQL sessions with worker-scoped settings from Kubernetes or Helm values:

| Control | Default | Purpose |
|---|---:|---|
| `RETENTION_DB_POOL_MIN_SIZE` | 2 | Maintains a small warm connection baseline |
| `RETENTION_DB_POOL_MAX_SIZE` | 10 | Bounds concurrent retention claims per worker pod |
| `RETENTION_DB_POOL_TIMEOUT_SECONDS` | 2 s | Limits time spent waiting to acquire a client-pool connection |
| `RETENTION_DB_CIRCUIT_FAILURE_THRESHOLD` | 3 | Opens the fail-closed breaker after repeated pool timeouts |
| `RETENTION_DB_CIRCUIT_RESET_SECONDS` | 30 s | Limits open-state duration before one controlled recovery probe |
| `RETENTION_DB_STATEMENT_TIMEOUT_MS` | 5,000 ms | Cancels a statement that exceeds the worker’s execution budget |
| `RETENTION_DB_LOCK_TIMEOUT_MS` | 1,500 ms | Cancels a statement that spends too long waiting for a lock |
| `RETENTION_DB_IDLE_TRANSACTION_TIMEOUT_MS` | 10,000 ms | Prevents an idle worker transaction from retaining locks indefinitely |

The implementation applies the timeout parameters through PostgreSQL connection options when pooled connections are opened. This scopes the values to the worker rather than applying them to every database user.

PostgreSQL documents that `statement_timeout` limits statement execution time, `lock_timeout` applies specifically while waiting for locks, and `idle_in_transaction_session_timeout` protects against sessions that remain idle in an open transaction. It also advises against setting the first two values indiscriminately in `postgresql.conf`, because that affects all sessions. [1]

## Capacity model before increasing a pool

Set a database connection budget before raising `maxSize`. At a minimum, reserve capacity for PostgreSQL superuser/emergency access, monitoring, migration tooling, backups, replication, the Gateway issuance role, the Worker role, and all other application pools.

```text
sum(max pool connections of all application replicas)
+ administrative/monitoring connections
+ emergency reserve
<= PostgreSQL max_connections - reserved_connections - superuser_reserved_connections
```

PostgreSQL uses `max_connections` to determine the maximum concurrent server connections, and resource allocation—including shared memory—scales with that setting. The server also provides reserved connection slots for privileged roles and superusers. [2]

For this worker, calculate the upper bound as:

```text
worker_pods × RETENTION_DB_POOL_MAX_SIZE
```

For example, two worker pods with `maxSize: 10` can create up to 20 worker connections. This must be budgeted alongside every other service; do not multiply replica counts only after a deployment autoscaler has already scaled.

## Timeout ordering and rationale

The recommended order is:

```text
lock_timeout (1.5 s)
    < pool acquisition timeout (2 s)
    < statement_timeout (5 s)
    < idle_in_transaction_session_timeout (10 s)
```

This causes an individual lock wait to fail before the total statement budget is consumed, limits local client-pool queueing, then prevents unexpectedly long statements or idle transactions from retaining scarce resources. PostgreSQL notes that setting `lock_timeout` equal to or greater than `statement_timeout` is ineffective because the statement timeout would fire first. [1]

A timeout is a **fail-closed outcome**, not a prompt to retry the same deletion token blindly. A timeout after the worker has consumed authorization requires reconciliation of the authorization row and index state before a controlled retry mechanism can be considered.

## Recommended staged tuning procedure

| Stage | Change | Required evidence | Promotion gate |
|---|---|---|---|
| Baseline | Keep `maxSize=10`, 2 s acquire timeout | Unique and contention Locust profiles; lock waits; pool waiters; circuit state | No security failures and known current baseline |
| Small adjustment | Raise or lower one parameter by at most 20% | Same image, schema, query plan, and test profile | p95, lock waits, and circuit-open count do not regress |
| Canary | Apply to one worker pod | Per-pod pool metrics and PostgreSQL session counts | No saturation/circuit-open event for the defined window |
| Rollout | Apply through Helm or Kubernetes manifest | Deployment revision, dashboard evidence, peer review | Independent database and retention owner approval |
| Retrospective | Repeat Chaos Mesh exhaustion test | JUnit report and Prometheus validation artifact | Circuit opens/rejects/recovery behave as designed |

Use `kubectl rollout undo` or the previous Helm revision to recover from a bad tuning change. Do not compensate by disabling `lock_timeout`, raising `max_connections` without a database capacity assessment, or increasing all application pools together.

## Operational queries

Monitor the worker before and during a burst:

```promql
max(umoja_retention_worker_db_pool_waiting)
max(umoja_retention_worker_db_pool_available)
max(umoja_retention_worker_db_circuit_state)
increase(umoja_retention_worker_db_circuit_open_total[15m])
histogram_quantile(0.95, sum by (le) (rate(umoja_retention_worker_execution_seconds_bucket[5m])))
max(pg_retention_lock_wait_max_wait_seconds{environment="production"})
```

Use a privileged read-only operations role to inspect active database pressure:

```sql
SELECT
  state,
  wait_event_type,
  wait_event,
  count(*) AS sessions
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY state, wait_event_type, wait_event
ORDER BY sessions DESC;
```

To identify lock waits and blockers:

```sql
SELECT
  waiting.pid AS waiting_pid,
  now() - waiting.query_start AS waiting_for,
  pg_blocking_pids(waiting.pid) AS blocking_pids,
  waiting.query
FROM pg_stat_activity AS waiting
WHERE waiting.wait_event_type = 'Lock'
ORDER BY waiting.query_start;
```

## Role-scoped server settings alternative

If the platform database administrator chooses to enforce the same worker limits server-side, apply them only to the worker application login role and database:

```sql
ALTER ROLE retention_worker_app IN DATABASE umoja
  SET statement_timeout = '5s';

ALTER ROLE retention_worker_app IN DATABASE umoja
  SET lock_timeout = '1500ms';

ALTER ROLE retention_worker_app IN DATABASE umoja
  SET idle_in_transaction_session_timeout = '10s';
```

Keep the application-level connection options as the deployment source of truth or remove duplicates deliberately after testing; do not leave conflicting values unexplained. The Gateway issuance role may require different limits and must be tuned independently.

## What not to tune for this problem

`max_locks_per_transaction` is not a fix for row-level claim contention. PostgreSQL documents that it sizes shared lock-table capacity for distinct database objects and does not limit the number of rows a transaction can lock. [3]

Similarly, do not use a global `statement_timeout` to solve an isolated worker burst, and do not turn off conditional authorization updates to reduce contention. The atomic `UPDATE ... WHERE consumed_at IS NULL ... RETURNING` is the exactly-once control and must remain intact.

## Recovery after saturation

When the circuit opens, follow the PagerDuty lock-wait triage procedure. Verify the circuit has closed only after a successful half-open claim, pool waiters have returned to baseline, PostgreSQL lock waits are below the alert threshold, and sampled authorizations reconcile to their exact index state. A connection-pool change is not complete until these conditions are evidenced.

## References

[1]: https://www.postgresql.org/docs/current/runtime-config-client.html "PostgreSQL Documentation — Client Connection Defaults"
[2]: https://www.postgresql.org/docs/current/runtime-config-connection.html "PostgreSQL Documentation — Connections and Authentication"
[3]: https://www.postgresql.org/docs/current/runtime-config-locks.html "PostgreSQL Documentation — Lock Management"
