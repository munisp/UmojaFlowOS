# Prometheus and Alertmanager Configuration for Retention Circuit Breaker Alerts

## Purpose

This configuration detects two related but distinct conditions in the production retention delete worker: the PostgreSQL connection-pool circuit is currently open, and the circuit has opened at least once in the recent observation window. The former identifies active fail-closed rejection; the latter preserves evidence of a short-lived saturation event that may have recovered before an operator opens a dashboard.

The authoritative rule file is `infra/retention-gateway/prometheus-production-circuit-alerts.yml`. The Alertmanager route extension is `infra/retention-gateway/alertmanager-production-pagerduty-lockwait.yml`.

## Prometheus rule group

```yaml
groups:
  - name: umoja-retention-worker-production-circuit
    rules:
      - alert: UmojaRetentionDatabaseCircuitOpen
        expr: max(umoja_retention_worker_db_circuit_state{environment="production"}) == 1
        for: 30s
        labels:
          severity: critical
          urgency: page
          service: retention-delete-worker
          team: engineering
          compliance_domain: audit_retention
          environment: production
        annotations:
          summary: Retention worker PostgreSQL circuit breaker is open
          runbook_url: https://docs.example.invalid/runbooks/retention-worker-postgres-circuit

      - alert: UmojaRetentionDatabaseCircuitOpenTransition
        expr: increase(umoja_retention_worker_db_circuit_open_total{environment="production"}[5m]) > 0
        for: 0s
        labels:
          severity: critical
          urgency: page
          service: retention-delete-worker
          team: engineering
          compliance_domain: audit_retention
          environment: production
        annotations:
          summary: Retention worker PostgreSQL circuit breaker opened
          runbook_url: https://docs.example.invalid/runbooks/retention-worker-postgres-circuit

      - alert: UmojaRetentionDatabaseCircuitRejectingRequests
        expr: increase(umoja_retention_worker_db_circuit_rejections_total{environment="production"}[5m]) > 0
        for: 1m
        labels:
          severity: warning
          service: retention-delete-worker
          team: engineering
          compliance_domain: audit_retention
          environment: production
```

| Alert | Expression intent | Delivery | Why it exists |
|---|---|---|---|
| `UmojaRetentionDatabaseCircuitOpen` | Breaker state is `1` for 30 seconds | PagerDuty plus engineering webhook | Establishes an active availability and integrity incident |
| `UmojaRetentionDatabaseCircuitOpenTransition` | Counter increased during five minutes | PagerDuty plus engineering webhook | Captures transient saturation that may no longer be open |
| `UmojaRetentionDatabaseCircuitRejectingRequests` | Open breaker rejected claims for one minute | Engineering webhook | Quantifies continuing fail-closed impact |

The worker must be scraped with `environment="production"`. Add this as an external or scrape label; do not rely on an environment variable inside a metric emitted by the application.

```yaml
scrape_configs:
  - job_name: umoja-retention-worker
    metrics_path: /metrics
    scheme: https
    static_configs:
      - targets:
          - umoja-retention-worker.security.svc.cluster.local:8443
        labels:
          environment: production
          service: retention-delete-worker
```

## Prometheus rule loading

Place the rule file into the Prometheus rules mount and reference it from the server configuration:

```yaml
rule_files:
  - /etc/prometheus/rules/umoja-retention-production-circuit.yml
```

Validate before rollout:

```bash
promtool check rules infra/retention-gateway/prometheus-production-circuit-alerts.yml
```

Apply using the organization’s GitOps controller or the Prometheus operator’s `PrometheusRule` equivalent. Do not copy an unreviewed rule directly into a running production container.

## Alertmanager routing

Merge the following routes and receivers into the production Alertmanager configuration:

```yaml
route:
  receiver: default
  group_by: [alertname, service, environment, database]
  routes:
    - matchers:
        - alertname =~ "UmojaRetentionDatabaseCircuit(Open|OpenTransition)"
        - service = "retention-delete-worker"
        - environment = "production"
        - urgency = "page"
      receiver: pagerduty-retention-postgres-critical
      group_wait: 0s
      group_interval: 5m
      repeat_interval: 30m
    - matchers:
        - team = "engineering"
        - service = "retention-delete-worker"
        - environment = "production"
      receiver: webhook-retention-engineering
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 2h

receivers:
  - name: webhook-retention-engineering
    webhook_configs:
      - url_file: /etc/alertmanager/secrets/retention-engineering-webhook/url
        send_resolved: true
        max_alerts: 0
  - name: pagerduty-retention-postgres-critical
    pagerduty_configs:
      - routing_key_file: /etc/alertmanager/secrets/retention-postgres-pagerduty/routing-key
        severity: critical
        component: postgresql-lock-manager
        class: retention-authorization
        group: umojaflowos-retention-production
        description: '{{ .CommonAnnotations.summary }}'
        details:
          runbook_url: '{{ .CommonAnnotations.runbook_url }}'
          observed_value: '{{ .CommonAnnotations.observed_value }}'
```

The PagerDuty routing key and engineering webhook URL must be mounted from independent secrets. The worker service account, OpenSearch client identity, and database application roles must not have read access to the Alertmanager secret namespace.

## Secret-mount example

```yaml
volumes:
  - name: retention-postgres-pagerduty
    secret:
      secretName: retention-postgres-pagerduty
  - name: retention-engineering-webhook
    secret:
      secretName: retention-engineering-webhook

volumeMounts:
  - name: retention-postgres-pagerduty
    mountPath: /etc/alertmanager/secrets/retention-postgres-pagerduty
    readOnly: true
  - name: retention-engineering-webhook
    mountPath: /etc/alertmanager/secrets/retention-engineering-webhook
    readOnly: true
```

## End-to-end validation

First use a staging Alertmanager and PagerDuty test service. Confirm Prometheus sees the three worker series:

```promql
umoja_retention_worker_db_circuit_state
umoja_retention_worker_db_circuit_open_total
umoja_retention_worker_db_circuit_rejections_total
```

Run the approved staging Chaos Mesh pool-saturation experiment. Confirm the transition alert fires when `umoja_retention_worker_db_circuit_open_total` increments, the active-state alert fires if the open state persists at least 30 seconds, and both resolve after recovery. Verify that the PagerDuty event carries the alert name, production/staging label, service, and runbook URL, while the engineering webhook receives both firing and resolved notifications.

Do not simulate circuit opening in production by reducing thresholds, killing PostgreSQL, disabling TLS, or exhausting database slots. Validate production routing only with a PagerDuty test service or Alertmanager configuration test under approved change control.

## References

[1]: https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/ "Prometheus Documentation — Alerting Rules"
[2]: https://prometheus.io/docs/alerting/latest/configuration/ "Prometheus Documentation — Alertmanager Configuration"
