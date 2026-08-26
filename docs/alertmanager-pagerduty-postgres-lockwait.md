# PagerDuty Escalation for Production PostgreSQL Lock Waits

## Purpose

This configuration pages the retention on-call service when `pg_retention_lock_wait_max_wait_seconds` exceeds **two seconds for two minutes** in production. It is intentionally separate from staging load-test alerts.

## Required artifacts

| Artifact | Role |
|---|---|
| `prometheus-production-lockwait-alerts.yml` | Creates warning and critical lock-wait alerts from production PostgreSQL exporter metrics |
| `alertmanager-production-pagerduty-lockwait.yml` | Routes only the critical production alert to PagerDuty |
| PagerDuty routing-key secret | Supplies the integration key without exposing it in Git or a ConfigMap |

## 1. Mount the PagerDuty routing key

Create the secret through the approved external-secrets mechanism. If a temporary manual staging-equivalent secret is required, use:

```bash
kubectl -n monitoring create secret generic retention-postgres-pagerduty \
  --from-literal=routing-key="$PAGERDUTY_ROUTING_KEY"
```

Mount it read-only at:

```text
/etc/alertmanager/secrets/retention-postgres-pagerduty/routing-key
```

The Alertmanager service account must be able to read this mounted Secret, but neither the retention worker nor the Locust CronJob should receive it.

## 2. Load the Prometheus production rule

Merge `infra/retention-gateway/prometheus-production-lockwait-alerts.yml` into the production rule bundle. Confirm the PostgreSQL exporter supplies the `environment="production"` label and a `database` label; without both labels, the rule must not be treated as production coverage.

Validate the expression in the Prometheus UI:

```promql
max by (database) (pg_retention_lock_wait_max_wait_seconds{environment="production"})
```

## 3. Merge the Alertmanager route

Merge the `routes`, `receivers`, and `inhibit_rules` in `alertmanager-production-pagerduty-lockwait.yml` into the production Alertmanager configuration. Do not replace unrelated routes.

The critical alert carries all required routing labels:

```text
alertname=UmojaRetentionPostgresLockWaitProductionCritical
service=retention-delete-worker
environment=production
urgency=page
```

Alertmanager sends a PagerDuty event immediately (`group_wait: 0s`) and repeats it every 30 minutes while the alert remains firing.

## 4. Validate safely

Use a non-production alert receiver or a PagerDuty test service before production routing. Verify all of the following:

1. The one-second warning reaches the default non-page receiver.
2. A synthetic two-second critical alert reaches the PagerDuty test service.
3. The PagerDuty incident includes the database label, observed value, and runbook URL.
4. The critical alert inhibits the matching warning for the same service and database.
5. Alert resolution closes the PagerDuty incident.
6. A non-production or unrelated PostgreSQL alert does not route to the production retention escalation service.

## 5. Initial incident response

When the page fires, pause retention workload changes, inspect `pg_stat_activity` and `pg_locks`, check worker pool saturation metrics, and confirm that no authorization outcome is ambiguous. Do not increase pool sizes or relax authorization locking during an incident without the database owner and security owner approval.
