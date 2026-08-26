# Triage: `UmojaRetentionPostgresLockWaitProductionCritical`

## Trigger condition

This procedure applies when PagerDuty receives `UmojaRetentionPostgresLockWaitProductionCritical`: the maximum PostgreSQL retention-authorization lock wait has exceeded **two seconds for at least two minutes** in production.

> Treat the alert as a data-integrity and availability event. Do not increase connection-pool size, relax authorization locking, disable mTLS, or retry OpenSearch deletion blindly while the alert is firing.

## Roles and timing

| Window | Primary owner | Required outcome |
|---|---|---|
| 0–5 minutes | Retention on-call | Acknowledge, contain change activity, confirm scope |
| 5–15 minutes | Database on-call | Identify blockers, pool saturation, and lock graph |
| 15–30 minutes | Security/retention owner | Decide recovery or escalation after authorization reconciliation |
| Closure | Incident commander | Preserve evidence and verify all recovery gates |

## 0–5 minutes: acknowledge and establish scope

1. Acknowledge the PagerDuty incident and record the incident ID, alert fingerprint, database label, observed value, and firing timestamp.
2. Freeze retention-worker rollouts, certificate rotations, schema changes, and manual deletion work. Leave the worker running unless a confirmed identity compromise or runaway failure requires approved containment.
3. Confirm the alert is production-scoped:

```promql
max by (database) (pg_retention_lock_wait_max_wait_seconds{environment="production"})
```

4. Check whether the failure is isolated to the retention worker:

```promql
sum by (result) (increase(umoja_retention_worker_failures_total[10m]))
max(umoja_retention_worker_db_pool_waiting)
max(umoja_retention_worker_db_pool_available)
```

5. Capture the active Grafana time range, worker image digest, deployment revision, and current PostgreSQL connection-pool settings before changing anything.

## 5–15 minutes: inspect PostgreSQL blockers

Use a privileged, read-only operational role; do not connect as the worker or gateway role. Identify blocked and blocking sessions:

```sql
SELECT
  waiting.pid AS waiting_pid,
  waiting.usename AS waiting_user,
  waiting.application_name AS waiting_application,
  waiting.wait_event_type,
  waiting.wait_event,
  now() - waiting.query_start AS waiting_for,
  pg_blocking_pids(waiting.pid) AS blocking_pids,
  waiting.query
FROM pg_stat_activity AS waiting
WHERE waiting.wait_event_type = 'Lock'
ORDER BY waiting.query_start;
```

Inspect the blockers and transaction age:

```sql
SELECT
  pid,
  usename,
  application_name,
  state,
  now() - xact_start AS transaction_age,
  now() - query_start AS query_age,
  wait_event_type,
  wait_event,
  query
FROM pg_stat_activity
WHERE pid = ANY($1::int[])
ORDER BY xact_start NULLS LAST;
```

Investigate only the smallest necessary scope. A blocking session may be a schema change, backup/VACUUM operation, an idle transaction, an unrelated application query, or a retention authorization claim. Record its identity, statement, start time, and lock relationship.

## 15–30 minutes: contain safely and reconcile claims

| Finding | Safe action | Prohibited action |
|---|---|---|
| Worker pool waiting rises and availability is zero | Temporarily reduce incoming retention test/workload concurrency; inspect worker pool configuration | Increasing `RETENTION_DB_POOL_MAX_SIZE` during the incident without database-owner approval |
| Idle transaction is a confirmed blocker | Ask the session owner to finish or safely terminate it under the approved database incident process | Terminating sessions by pattern or force-killing PostgreSQL |
| Schema/maintenance operation blocks retention table | Pause or reschedule the change after change-owner approval | Applying DDL or `VACUUM FULL` to clear the alert |
| Multiple retention claims contend on one digest | Confirm this is a replay/load-test condition; preserve exactly-once behavior | Removing conditional claim predicates or unlocking authorization rows |
| `database_connection_pool_saturated` failures appear | Keep fail-closed behavior; scale analysis, not execution | Retrying requests with the same authorization token without reconciliation |

Before resuming normal work, reconcile the authorization table and OpenSearch state for sampled affected correlation IDs. Confirm each authorization is either unconsumed, consumed with an execution record, or consumed with a documented `already_deleted`/reconciliation outcome. An ambiguous claim state blocks recovery.

## Recovery gates

Do not resolve the incident until all gates are true:

1. `pg_retention_lock_wait_max_wait_seconds{environment="production"}` remains below 2 seconds for at least 15 minutes.
2. `umoja_retention_worker_db_pool_waiting` has returned to its normal baseline.
3. No `database_connection_pool_saturated`, OpenSearch authentication, or authorization failures continue to increase.
4. Authorization claims sampled during the incident are reconciled against index state.
5. The database owner and retention/security owner approve workload resumption.
6. A controlled staging replay reproduces neither the blocker nor duplicate execution before any permanent tuning change is promoted.

## Evidence and closure

Attach the PagerDuty incident timeline, Prometheus queries, Grafana screenshots/exports, `pg_stat_activity` and lock-query results, worker deployment/pool configuration, authorization reconciliation output, and recovery approvals to the immutable incident evidence store. Complete the retention-worker security-failure post-mortem template for any incident exceeding 30 minutes, involving authorization ambiguity, or requiring session termination.
