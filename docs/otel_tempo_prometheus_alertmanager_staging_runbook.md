# UmojaFlowOS Staging Observability Deployment Runbook

**Status:** Controlled staging procedure  
**Scope:** OpenTelemetry Collector, Grafana Tempo, Prometheus, and Alertmanager  
**Audience:** Platform Engineering, SRE, Security, Compliance, and independent release reviewers  
**Operating posture:** Fail closed for missing telemetry on payment, ledger, reconciliation, and compliance paths

## 1. Purpose and boundary

This runbook deploys an open-source observability path for UmojaFlowOS. Services emit traces, metrics, and logs through OTLP to the OpenTelemetry Collector. The Collector applies resource normalization, bounded batching, memory protection, and tenant-attribute safety. Metrics are exposed for Prometheus scraping. Prometheus evaluates alert rules and sends alert notifications to Alertmanager. Traces are exported to Grafana Tempo through OTLP/HTTP. Alertmanager does not store or process raw traces; it receives Prometheus alert notifications.

The procedure is for an authorized staging environment only. It must not be used to activate live customer payment processing, bypass provider controls, or replace required CBN evidence with local success.

## 2. Target topology

```text
Go / Rust / Python / TypeScript services
  OTLP gRPC :4317 or OTLP HTTP :4318
                    |
                    v
          OpenTelemetry Collector
          :13133 health / :8889 metrics
             |                    |
             |                    +--> Grafana Tempo OTLP/HTTP :4318
             |
             +--> Prometheus scrape :8889
                         |
                         +--> Alertmanager :9093
                                  |
                                  +--> approved email / webhook / PagerDuty / Slack gateway
```

## 3. Prerequisites

Before deployment, the Operations Owner records the staging cluster identifier, namespace, release SHA, Kubernetes context, approved data-retention values, and the authorized notification endpoints. The Security Owner confirms that notifications contain no payment payloads, secrets, access tokens, document contents, or customer identifiers.

The staging cluster must provide a Kubernetes API, persistent storage for Tempo and Prometheus, a secret-management mechanism, network policies, and a reachable internal DNS name for the Collector, Tempo, Prometheus, and Alertmanager services. PostgreSQL remains the canonical control-plane database; observability storage must not be used as a ledger or compliance system of record.

## 4. Namespace and service accounts

```bash
kubectl create namespace umoja-observability --dry-run=client -o yaml | kubectl apply -f -
kubectl -n umoja-observability create serviceaccount otel-collector --dry-run=client -o yaml | kubectl apply -f -
kubectl -n umoja-observability create serviceaccount tempo --dry-run=client -o yaml | kubectl apply -f -
kubectl -n umoja-observability create serviceaccount prometheus --dry-run=client -o yaml | kubectl apply -f -
kubectl -n umoja-observability create serviceaccount alertmanager --dry-run=client -o yaml | kubectl apply -f -
```

Apply a default-deny NetworkPolicy, then allow only service-to-Collector OTLP, Collector-to-Tempo OTLP, Prometheus-to-Collector scraping, Prometheus-to-Alertmanager notification, and approved Alertmanager egress. All other egress is denied by default.

## 5. Collector configuration

Use the repository configuration as the baseline:

```text
infra/observability/otel-collector-config.yaml
```

The deployment must provide these environment values through a secret or protected configuration:

| Variable | Required value |
|---|---|
| `OTEL_LAKEHOUSE_OTLP_ENDPOINT` | Approved OTLP endpoint if evidence export is enabled; otherwise use a staging-only backend. |
| `OTEL_LAKEHOUSE_AUTHORIZATION` | Secret reference, never a literal committed token. |
| `OTEL_TEMPO_OTLP_ENDPOINT` | Tempo OTLP/HTTP endpoint, normally `http://tempo.umoja-observability.svc.cluster.local:4318`. |
| `OTEL_ENVIRONMENT` | `staging`. |
| `OTEL_RESOURCE_ATTRIBUTES` | `service.namespace=umojaflowos,deployment.environment=staging`. |

For production-like staging, add the Tempo exporter to the Collector and route traces to it:

```yaml
exporters:
  otlphttp/tempo:
    endpoint: ${env:OTEL_TEMPO_OTLP_ENDPOINT}
    sending_queue:
      enabled: true
      num_consumers: 4
      queue_size: 2048

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, resource, transform/tenant_safety, batch]
      exporters: [otlphttp/tempo]
    metrics:
      receivers: [otlp, prometheus]
      processors: [memory_limiter, resource, transform/tenant_safety, batch]
      exporters: [prometheus]
```

Do not make Collector export failure block payment decisions synchronously. Instead, missing-telemetry alerts must fence or hold affected release/payment paths according to the service’s safety contract.

Validate the configuration before deployment:

```bash
otelcol --config infra/observability/otel-collector-config.yaml validate
kubectl apply --dry-run=server -f deploy/observability/otel-collector.yaml
```

If the repository does not contain a Kubernetes manifest, render the chosen Helm chart with the exact image digest and save the rendered output as staging evidence before applying it.

## 6. Grafana Tempo

Deploy Tempo in monolithic mode for a small staging environment or distributed mode when testing production-like scale. Enable OTLP gRPC and HTTP receivers, persistent storage, bounded retention, and authentication/network restrictions appropriate to the cluster.

Required checks:

```bash
kubectl -n umoja-observability rollout status deploy/tempo --timeout=180s
kubectl -n umoja-observability get svc tempo -o wide
kubectl -n umoja-observability port-forward svc/tempo 3200:3200
curl -fsS http://127.0.0.1:3200/ready
```

Tempo traces are diagnostic telemetry. They must not be treated as the authoritative source for financial settlement, regulatory evidence, or audit records. Trace sampling and retention must be documented, and sampling must not remove the signals needed to detect quorum loss, reconciliation mismatch, unsafe fencing, or compliance failures.

## 7. Prometheus

Configure Prometheus to scrape the Collector metrics endpoint and the application `/metrics` endpoints. Use the repository’s rule files:

```text
infra/monitoring/prometheus.yml
infra/monitoring/umoja-tigerbeetle-cluster-alerts.yml
infra/monitoring/mojaloop-signer-alerts.yml
```

A containerized Prometheus configuration normally uses:

```yaml
rule_files:
  - /etc/prometheus/rules/umoja-tigerbeetle-cluster-alerts.yml
  - /etc/prometheus/rules/mojaloop-signer-alerts.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: [alertmanager.umoja-observability.svc.cluster.local:9093]
```

Validate rules and configuration:

```bash
promtool check rules infra/monitoring/umoja-tigerbeetle-cluster-alerts.yml
promtool check rules infra/monitoring/mojaloop-signer-alerts.yml
promtool check config /path/to/rendered/prometheus.yml
kubectl -n umoja-observability rollout status statefulset/prometheus --timeout=180s
```

Prometheus must alert on missing Collector telemetry, TigerBeetle quorum loss, divergent cluster views, unsafe fencing, UNKNOWN-transfer growth, reconciliation mismatches, and signer retry exhaustion. The alert labels must include severity, service, environment, and the runbook URL. Payment and ledger alerts must be routed as critical and must not be inhibited by low-priority informational alerts.

## 8. Alertmanager

Configure Alertmanager with an explicit default route, critical ledger/security routes, warning routes, grouping, repeat intervals, and inhibition rules. Webhook credentials must be injected from the staging secret manager.

Illustrative structure:

```yaml
route:
  receiver: default-staging
  group_by: [alertname, service, environment]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h
  routes:
    - matchers: [severity="critical", environment="staging"]
      receiver: critical-staging
      continue: false
    - matchers: [severity="warning", environment="staging"]
      receiver: warning-staging

inhibit_rules:
  - source_matchers: [alertname="UmojaTigerBeetleQuorumLost"]
    target_matchers: [severity="warning"]
    equal: [environment, service]
```

Use a mock receiver or approved staging sink for validation. Do not send test alerts to a production PagerDuty service or public Slack channel.

Validate routing:

```bash
amtool check-config /path/to/rendered/alertmanager.yml
kubectl -n umoja-observability rollout status deploy/alertmanager --timeout=180s
kubectl -n umoja-observability port-forward svc/alertmanager 9093:9093
curl -fsS http://127.0.0.1:9093/-/ready
```

Trigger a controlled staging test alert and record the Alertmanager API response, receiver delivery result, timestamps, alert fingerprint, and acknowledgement. Remove the test alert after evidence capture.

## 9. Service configuration

Each service receives the following non-secret environment contract:

```text
OTEL_SERVICE_NAME=<stable-service-name>
OTEL_SERVICE_VERSION=<release-version>
OTEL_ENVIRONMENT=staging
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.umoja-observability.svc.cluster.local:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_PROPAGATORS=tracecontext,baggage
OTEL_RESOURCE_ATTRIBUTES=service.namespace=umojaflowos,deployment.environment=staging
```

Go services must initialize the OTLP provider before serving traffic and shut it down gracefully. Rust services must initialize the tracing subscriber and OTLP exporter before Axum serves requests. Python services must initialize the SDK before FastAPI receives traffic. TypeScript services must initialize the Node SDK before Express imports instrumented modules.

Tenant attributes must be bounded and normalized. Telemetry must use a stable tenant identifier or `unknown`; it must never include access tokens, raw KYC documents, account numbers, private keys, payment payloads, or full regulatory report bodies.

## 10. End-to-end validation

Run the repository’s local contract tests:

```bash
cd apps/control-plane
pnpm exec tsc --noEmit
pnpm exec vitest run server/otelTracePropagation.integration.test.ts server/otelCrossService.integration.test.ts

cd ../../services/ledger-gateway
cargo test

cd ../../
./.toolchain/bin/promtool check rules infra/monitoring/umoja-tigerbeetle-cluster-alerts.yml infra/monitoring/mojaloop-signer-alerts.yml
```

Then run staging checks:

```bash
kubectl -n umoja-observability get pods -o wide
kubectl -n umoja-observability get endpoints otel-collector tempo prometheus alertmanager
kubectl -n umoja-observability logs deploy/otel-collector --since=15m | grep -Ei 'error|failed|dropped|refused' || true
```

Generate one controlled trace through the control-plane, Dapr, Kafka, Temporal, ledger-gateway, TigerBeetle adapter, and reporting-analytics path. Search Tempo using the correlation ID or trace ID. Confirm that the trace crosses each boundary, spans do not contain prohibited payloads, and tenant context is preserved or explicitly marked `unknown`.

Confirm metric visibility in Prometheus:

```bash
curl -Gsf http://prometheus.umoja-observability.svc.cluster.local:9090/api/v1/query \
  --data-urlencode 'query=up{job="otel-collector"}'
```

Confirm Alertmanager receipt through its API or approved mock receiver. Capture end-to-end latency from metric condition to alert notification.

## 11. Fail-closed acceptance gates

The staging observability deployment passes only when all of the following are true:

| Gate | Acceptance criterion |
|---|---|
| Collector health | Collector is ready and has no persistent export, queue, memory-limit, or dropped-telemetry errors. |
| Trace export | A controlled trace reaches Tempo with cross-service trace ID continuity. |
| Metric export | Collector metrics are scraped by Prometheus and retain service/environment labels. |
| Alert evaluation | Quorum, divergence, unsafe-fence, UNKNOWN, reconciliation, and telemetry-loss rules evaluate correctly. |
| Notification | Critical alerts reach the approved staging receiver and warnings reach the warning receiver. |
| Tenant safety | Tenant context is bounded, non-secret, and present or explicitly `unknown`. |
| Security | Network policies, non-root containers, read-only filesystems, secret mounts, and TLS/authentication are verified. |
| Retention | Tempo, Prometheus, Alertmanager, and log retention values are recorded and approved. |
| Evidence | Logs, manifests, image digests, query results, alert fingerprints, and reviewer attestations are SHA-256 bound. |

Any missing telemetry on a payment, ledger, reconciliation, or compliance-critical path is a **NO-GO** for that path until the gap is explained, contained, and independently approved.

## 12. Rollback

Rollback the observability release if the Collector causes resource pressure, export queues grow without bound, Prometheus reload fails, Alertmanager routes critical alerts incorrectly, Tempo storage becomes unavailable, or telemetry contains prohibited data.

Rollback sequence:

```bash
kubectl -n umoja-observability rollout history deploy/otel-collector
kubectl -n umoja-observability rollout undo deploy/otel-collector --to-revision=<known-good>
kubectl -n umoja-observability rollout status deploy/otel-collector --timeout=180s
```

Then verify that the payment and ledger services remain fail-closed. Do not disable settlement fencing merely because observability is degraded. If the previous telemetry version cannot be restored, suspend the affected controlled-staging activity and open an incident/CAP record.

## 13. Audit evidence package

Retain the following immutable artifacts:

1. Release SHA and container image digests.
2. Rendered Collector, Tempo, Prometheus, Alertmanager, ServiceMonitor, Secret, and NetworkPolicy manifests.
3. Configuration-validation output from `promtool`, `amtool`, Helm, and Kubernetes server-side dry run.
4. Collector readiness, resource, export, and dropped-telemetry logs.
5. Tempo trace ID and sanitized span inventory.
6. Prometheus query outputs and alert rule-test results.
7. Alertmanager routing and receiver-delivery evidence.
8. Network-policy and secret-mount verification.
9. Retention and backup configuration.
10. Four independent release approvals bound to the same manifest SHA.

Hash every artifact, record it in the release evidence manifest, and store the bundle in the approved immutable evidence store. The evidence package must identify which results are local contract tests and which were produced by the authorized staging deployment.

## References

[1]: https://opentelemetry.io/docs/collector/ OpenTelemetry Collector documentation  
[2]: https://grafana.com/docs/tempo/latest/ Grafana Tempo documentation  
[3]: https://prometheus.io/docs/prometheus/latest/configuration/configuration/ Prometheus configuration documentation  
[4]: https://prometheus.io/docs/alerting/latest/alertmanager/ Alertmanager documentation
