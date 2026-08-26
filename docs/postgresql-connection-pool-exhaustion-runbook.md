# Production Runbook: PostgreSQL Connection Pool Exhaustion

## Scope and trigger

Use this runbook when any of the following alerts fire for the production `retention-delete-worker` service:

| Alert | Meaning | Severity |
|---|---|---|
| `UmojaRetentionDatabaseCircuitOpen` | The PostgreSQL pool circuit is actively open and new claims are rejected fail-closed | Critical/page |
| `UmojaRetentionDatabaseCircuitOpenTransition` | The circuit opened at least once in the last five minutes | Critical/page |
| `UmojaRetentionDatabaseCircuitRejectingRequests` | The open circuit is continuing to reject workload | Warning |
| `UmojaRetentionPostgresLockWaitProductionCritical` | Maximum PostgreSQL lock wait exceeded two seconds for two minutes | Critical/page |

The operational goal is to restore the durable authorization path without allowing an unsafe deletion, bypassing the circuit, or causing a retry storm.

## Ownership and boundaries

The incident commander owns coordination. The database owner performs privileged PostgreSQL diagnosis. The retention owner validates authorization reconciliation. The platform owner operates Kubernetes rollouts. The delete-worker service identity must not receive elevated PostgreSQL, Kubernetes, OpenSearch, or secret-management permissions during the incident.

## First five minutes: acknowledge, contain, preserve evidence

Acknowledge PagerDuty and open an incident record. Pause retention deployment changes and any scheduled load or Chaos activity. Do not automatically scale the worker, increase pool size, restart PostgreSQL, or retry rejected authorization tokens.

Capture the worker and alert state without exposing credentials:

```bash
kubectl -n security get deploy,pods -l app.kubernetes.io/name=umoja-retention-worker -o wide
kubectl -n security rollout history deployment/umoja-retention-worker
kubectl -n security logs deployment/umoja-retention-worker --since=15m
```

Capture Prometheus evidence for the incident window:

```promql
max(umoja_retention_worker_db_circuit_state{environment="production"})
increase(umoja_retention_worker_db_circuit_open_total{environment="production"}[15m])
increase(umoja_retention_worker_db_circuit_rejections_total{environment="production"}[15m])
max(umoja_retention_worker_db_pool_waiting{environment="production"})
max(pg_retention_lock_wait_max_wait_seconds{environment="production"})
```

Record the alert fingerprint, correlation IDs visible in structured logs, worker image digest, Kubernetes deployment revision, pool configuration, and database endpoint. Store the resulting evidence through the approved immutable incident-evidence path.

## Five to fifteen minutes: classify the condition

Determine which of the following is occurring before changing configuration.

| Pattern | Likely condition | Initial action |
|---|---|---|
| Pool waiting grows; circuit opens; PostgreSQL remains reachable | Application burst or undersized pool | Preserve fail-closed state; inspect workload and database wait events |
| Lock waits exceed threshold; pool waiters rise | Long transaction or blocked authorization claim | Identify blocker using read-only database queries |
| Database connection errors or no worker health | Database availability, routing, TLS, or credential issue | Verify network, TLS, endpoint, and database health; do not relax mTLS |
| Circuit opens just after rollout | Configuration, connection budget, certificate, or pool initialization regression | Stop rollout and compare previous deployment revision |

Use a database operations role with read-only permissions for diagnosis. Never run these queries from the Worker role.

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

```sql
SELECT
  waiting.pid AS waiting_pid,
  waiting.usename,
  now() - waiting.query_start AS waiting_for,
  pg_blocking_pids(waiting.pid) AS blocking_pids,
  waiting.query
FROM pg_stat_activity AS waiting
WHERE waiting.wait_event_type = 'Lock'
ORDER BY waiting.query_start;
```

```sql
SELECT
  a.pid,
  a.usename,
  a.application_name,
  a.state,
  a.backend_type,
  now() - a.xact_start AS transaction_age,
  now() - a.query_start AS query_age,
  a.wait_event_type,
  a.wait_event
FROM pg_stat_activity AS a
WHERE a.datname = current_database()
ORDER BY a.xact_start NULLS LAST;
```

## Containment decision

The circuit breaker is the primary containment mechanism. While it is open, requests receive `database_circuit_open` and HTTP 503 before attempting PostgreSQL or OpenSearch. Leave it active while the source of saturation is investigated.

If a rollout caused the event, stop the rollout and return to the last verified deployment revision only after the database owner and retention owner agree that the previous configuration is safe:

```bash
kubectl -n security rollout undo deployment/umoja-retention-worker
kubectl -n security rollout status deployment/umoja-retention-worker --timeout=10m
```

Scaling is not an automatic mitigation. More replicas multiply the maximum number of database connections and can worsen saturation. Increase or decrease replicas only under an approved capacity plan and after checking the full PostgreSQL connection budget.

## Reconciliation before recovery

A timeout can occur after an authorization has been claimed but before a caller receives a final response. Therefore, do not resubmit a token solely because the caller saw HTTP 503.

The retention owner must reconcile affected `decision_digest` values against the authorization record, the signed manifest, and exact OpenSearch index state. Use the existing reconciliation controls and preserve correlation IDs. A request may be retried only through the approved idempotent workflow after it is clear whether the original authorization was consumed and whether a physical index action occurred.

## Recovery gates

The incident commander may move to recovery only when all conditions below are true.

| Gate | Required evidence |
|---|---|
| Database reachability | Worker health is stable and PostgreSQL TLS/authentication checks succeed |
| Circuit recovery | One controlled half-open claim succeeds; circuit state returns to `0` |
| Pool recovery | `db_pool_waiting` returns to baseline and no new pool saturation failures occur |
| Lock recovery | Maximum retention lock wait is below two seconds for at least 15 minutes |
| Integrity | Sampled claimed authorizations reconcile to signed manifest and exact index state |
| Alert recovery | Circuit-open and critical lock-wait alerts are resolved; PagerDuty event has evidence attached |
| Independent approval | Database owner and retention owner record sign-off |

After recovery, re-enable paused scheduled testing only after the incident record is updated and the staging/production separation remains intact.

## Prohibited actions

Do not perform any of the following as an emergency workaround:

- Disable mTLS, OpenSearch authorization, manifest-signature checks, legal holds, or PostgreSQL conditional updates.
- Increase `max_connections` or every application pool without a capacity assessment.
- Increase worker replicas to force throughput during saturation.
- Terminate PostgreSQL backends broadly; target a confirmed blocker only with database-owner approval.
- Delete OpenSearch indices manually, by alias, or through wildcards.
- Retry an unknown authorization token until it succeeds.
- Run Chaos Mesh, Locust, schema migration, or load testing in production while the incident is active.

## Follow-up and prevention

Within one business day, review pool waiter, circuit-open, lock wait, transaction age, and request-rate trends. Update the capacity model using the maximum possible worker connections across all replicas. Run the approved staging Chaos Mesh saturation test and Locust contention profile before promoting any pool, timeout, query, schema, or replica-count change.

PostgreSQL documents that `statement_timeout` limits total statement duration, `lock_timeout` limits lock acquisition waits, and `idle_in_transaction_session_timeout` protects against idle transactions holding resources. Apply these controls per worker role or connection, not indiscriminately in global configuration. [1] PostgreSQL also documents that increasing `max_connections` consumes additional resources and that reserved slots preserve emergency access. [2]

## References

[1]: https://www.postgresql.org/docs/current/runtime-config-client.html "PostgreSQL Documentation — Client Connection Defaults"
[2]: https://www.postgresql.org/docs/current/runtime-config-connection.html "PostgreSQL Documentation — Connections and Authentication"
[3]: https://www.postgresql.org/docs/current/monitoring-stats.html "PostgreSQL Documentation — Monitoring Database Activity"
