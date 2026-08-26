# Retention Worker PostgreSQL Row-Locking Load Test Runbook

## Purpose

This runbook benchmarks the throughput and latency of the retention worker’s PostgreSQL authorization-claim path under high concurrency. It uses Locust to call the worker’s normal HTTP API, so measurements include request parsing, HMAC verification, transactional `SELECT ... FOR UPDATE`, conditional claim update, and the safe nonexistent-index identity path.

No real audit index is deleted. The fixture generator produces authorization requests for deliberately nonexistent index names. After a successful authorization claim, the worker returns `already_deleted` because OpenSearch reports the synthetic index absent.

## Prerequisites

| Requirement | Purpose |
|---|---|
| Isolated staging PostgreSQL and worker deployment | Prevents synthetic test rows from affecting operational activity |
| Gateway database credential | Pre-registers authorization rows; never pass this credential to Locust |
| Worker bearer token | Calls the internal worker API |
| Gateway HMAC secret file | Signs synthetic worker authorization tokens |
| Prometheus scrape of worker metrics | Correlates application metrics with Locust results |
| Capacity-approved test window | Avoids competing with retention execution or reconciliation jobs |

Use `retention_gateway_app` only for fixture registration. Locust and the worker must use `retention_worker_app`. This proves the intended database-role separation during the test.

## 1. Install the test dependencies

```bash
cd /home/ubuntu/UmojaFlowOS
python3 -m pip install -r simulators/retention_gateway/requirements.txt
```

## 2. Generate synthetic authorizations

Export the Gateway-only credential and signing-secret file path from an approved secret manager. Do not save these values in shell history.

```bash
export RETENTION_GATEWAY_DATABASE_URL='postgresql://retention_gateway_app:...@postgres.security.svc.cluster.local:5432/umoja?sslmode=verify-full'
export RETENTION_GATEWAY_HMAC_SECRET_FILE=/run/secrets/retention-gateway/hmac

python3 scripts/infra/prepare_retention_worker_lock_loadtest.py \
  --count 20000 \
  --ttl-minutes 30 \
  --output /tmp/retention-worker-lock-fixture.json
```

The fixture file has mode `0600` and contains short-lived authorization tokens. Delete it immediately after testing.

## 3. Unique-digest throughput profile

This profile measures independent PostgreSQL row locks. Each Locust request uses a distinct authorization row and should produce HTTP `200` with `status: already_deleted`.

```bash
export RETENTION_WORKER_LOADTEST_FIXTURE=/tmp/retention-worker-lock-fixture.json
export RETENTION_WORKER_BEARER_TOKEN="$(pass show staging/retention-worker-bearer)"
export LOCUST_SCENARIO=unique

locust -f tests/load/locust_retention_worker.py \
  --host https://umoja-retention-worker.security.svc.cluster.local:8443 \
  --headless --users 200 --spawn-rate 25 --run-time 10m \
  --csv /tmp/retention-lock-unique
```

Increase concurrency gradually, for example 25, 50, 100, 200, and 400 users. Generate a fresh fixture for each run so that previously consumed digests are not treated as replay attempts.

## 4. Single-digest contention profile

This profile proves that many simultaneous requests cannot consume the same authorization twice. One request may return `already_deleted`; all others should return `denied_replay_or_consumed` with HTTP `409`. Locust treats both outcomes as expected.

```bash
export LOCUST_SCENARIO=contention
locust -f tests/load/locust_retention_worker.py \
  --host https://umoja-retention-worker.security.svc.cluster.local:8443 \
  --headless --users 200 --spawn-rate 100 --run-time 2m \
  --csv /tmp/retention-lock-contention
```

The success criterion is exactly one PostgreSQL `consumed_at` update for the contention digest. The high number of replay denials is expected and should not be interpreted as a service defect.

## 5. Review Locust results

Review the CSV files:

| File | Use |
|---|---|
| `*_stats.csv` | Requests/sec, failure rate, average, median, p95/p99 latency |
| `*_stats_history.csv` | Throughput and latency progression during ramp-up |
| `*_failures.csv` | Unexpected statuses or payload failures only |
| `*_exceptions.csv` | Locust client exceptions |

For unique claims, investigate any failure that is not `already_deleted`. For contention, investigate any status other than `already_deleted` or `denied_replay_or_consumed`.

## 6. Review Prometheus metrics

Compare Locust output with the worker’s emitted metrics:

```promql
sum(rate(umoja_retention_worker_requests_total{operation="delete"}[1m]))

histogram_quantile(0.95, sum by (le) (
  rate(umoja_retention_worker_execution_seconds_bucket[5m])
))

sum by (result) (increase(umoja_retention_worker_results_total[10m]))

sum by (result) (increase(umoja_retention_worker_failures_total[10m]))
```

The unique profile should show `already_deleted` results and no authentication, authorization, or execution-error labels. The contention profile should show one `already_deleted` result and many `denied_replay_or_consumed` results; this indicates PostgreSQL locking prevented replay.

## 7. Database integrity verification

After a run, verify claim behavior using a read-only monitoring role:

```sql
SELECT execution_status, count(*)
FROM retention_delete_authorizations
WHERE issued_at >= now() - interval '30 minutes'
GROUP BY execution_status;

SELECT decision_digest, consumed_at
FROM retention_delete_authorizations
WHERE decision_digest = '<contention-decision-digest>';
```

The contention digest must have one non-null `consumed_at` value. No test request should target an index that exists in OpenSearch.

## 8. Suggested acceptance thresholds

Thresholds must be set from a measured baseline for the actual cluster size and storage class. A safe initial gate is:

| Signal | Suggested gate |
|---|---|
| Unique profile unexpected failures | 0% |
| Authentication or authorization failures | 0 |
| Contention digest claims | Exactly 1 |
| Worker p95 latency | Baseline + approved tolerance |
| PostgreSQL lock waits | No sustained growth during steady-state load |
| Unauthorized OpenSearch deletion | 0 |

## 9. Cleanup

Delete the fixture and reconcile synthetic authorizations after the test window:

```bash
shred -u /tmp/retention-worker-lock-fixture.json
```

Retain sanitized Locust CSV files, Prometheus query results, and database reconciliation output as performance evidence. Do not retain bearer tokens, HMAC secrets, or raw database URLs.
