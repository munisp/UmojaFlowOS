# UmojaFlowOS OpenTelemetry Coverage Contract

## Scope

This document defines the observability contract for Go, Rust, and Python services and the requested middleware. OpenTelemetry provides the common telemetry model and transport; it does not automatically instrument every product. Components must either emit OTLP directly, expose a supported exporter/receiver, or be wrapped by a service-level custom span/metric adapter.

## Coverage matrix

| Component | Coverage method | Required signals | Status/constraint |
|---|---|---|---|
| Go payment-engine | Go OTel SDK; HTTP/gRPC client/server middleware; custom payment/rail/ledger spans | Traces, metrics, logs; payment ID and tenant ID as controlled attributes | Requires SDK initialization at process start and propagation across provider/ledger calls. |
| Rust ledger-gateway | `tracing` + OpenTelemetry layer; HTTP middleware; custom ledger/reconciliation spans | Traces, metrics, structured logs; cluster/ledger outcome | Must never record secrets or raw account/customer data. |
| Python document-intelligence | OpenTelemetry Python SDK; FastAPI/HTTPX instrumentation; custom OCR/model/provenance spans | Traces, metrics, logs; analysis job and tenant attributes | Model inputs and documents must be represented by hashes/references, not payloads. |
| Kafka | Kafka client instrumentation in producers/consumers; broker metrics exporter/JMX where available | Producer/consumer traces, lag, failures, rebalance, throughput | Trace context must be carried in message headers; broker itself is monitored through exporter/metrics. |
| Dapr | Dapr tracing configuration and sidecar OTLP export; app-level spans | Service invocation, pub/sub, state store, retries, sidecar health | Use Dapr trace propagation; avoid duplicate spans when app SDK already instruments the same call. |
| Fluvio | Producer/consumer custom instrumentation around client calls; exporter/metrics if deployed | Topic/partition, lag, retries, errors, throughput | No assumption of native OTLP; wrap Go/Rust clients and preserve message correlation without payloads. |
| Temporal | Temporal SDK interceptors and worker/client tracing; Temporal metrics endpoint | Workflow/run/activity traces, retries, task queues, failures, latency | Propagate tenant context through workflow headers; do not put sensitive data in workflow attributes. |
| PostgreSQL | Application DB instrumentation plus `postgresql` collector receiver/exporter | Query latency, pool saturation, errors, transactions, locks | SQL text must be sanitized/obfuscated; tenant ID from request context, not arbitrary SQL labels. |
| Keycloak | OIDC/auth spans in callers; Keycloak event/audit export and metrics/JMX where enabled | Token issuance/validation latency, auth failures, realm/client events | Do not export tokens, client secrets, or full identity claims. |
| Permify | HTTP/gRPC client instrumentation and service metrics | Authorization latency, denials, policy errors, tenant/schema identifiers | Keep subject/object IDs hashed or pseudonymous. |
| Redis | Client instrumentation; Redis exporter for server metrics | Command latency, errors, pool saturation, evictions, replication | Never export keys or values; use command class and hashed tenant reference. |
| Mojaloop | FSPIOP HTTP/gRPC instrumentation and custom transfer/quote spans | Request lifecycle, timeout, 4xx/5xx, signer latency, transfer state | Preserve correlation and idempotency references without payloads or secrets. |
| OpenSearch | Client instrumentation and exporter/cluster metrics | Query/index latency, rejected requests, shard/cluster health, bulk failures | Redact query bodies and customer data; index/tenant labels must be bounded. |
| OpenAppSec | Controller/exporter metrics and security-event log ingestion | Block/allow/challenge, policy violations, model health, latency | OTel may ingest normalized security events; native tracing depends on deployment integration. |
| APISIX | OpenTelemetry plugin for request traces; Prometheus metrics; access/security logs | Route latency, upstream errors, rate limits, auth failures | Configure W3C propagation and redact authorization headers. |
| TigerBeetle | Custom ledger-client spans/metrics in Go/Rust gateway; cluster health exporter | Quorum, node-view divergence, consensus errors, UNKNOWN outcomes, reconciliation | No blind assumption of native OTLP; ledger facts remain authoritative and sensitive. |
| Apache Sedona | Application-level spans around spatial SQL/UDF and job execution; Spark metrics | Spatial query latency, job failure, shuffle/partition metrics | Trace query/job identifiers; do not export geometry or personal location data. |
| GeoLibre | Application-level spans around tile/style/geospatial API calls; HTTP instrumentation | Tile latency, render failures, cache hit/miss, upstream errors | Instrument the service using GeoLibre; the library itself is not assumed to be an OTLP emitter. |
| Lakehouse | OTLP/HTTP export to lakehouse telemetry intake plus Spark/Trino/Iceberg metrics | Ingest latency, schema failures, compaction, query/job lineage, retention | Treat OTel telemetry as a governed data product with tenant partitioning and retention. |
| Prometheus/Alertmanager | Prometheus scrapes collector metrics and alert rules; Alertmanager routes incidents | Alert firing, delivery, acknowledgement, receiver failures | OTel Collector exposes Prometheus-compatible metrics; Alertmanager remains the open-source notification path. |

## Tenant isolation contract

Every inbound request must establish a bounded `tenant.id` from an authenticated, authorized source. The value is propagated through W3C trace context and messaging headers. Metrics must use a bounded tenant label only where cardinality is controlled; otherwise use a tenant hash, aggregate, or exemplars. Logs should contain a tenant reference and correlation ID but never raw tokens, secrets, documents, account numbers, private keys, SQL values, or full AML case content.

Cross-tenant requests, missing tenant context on a tenant-scoped operation, or a tenant ID that fails authorization must create an error span and fail closed. Collector processors normalize missing tenant attributes to `unknown` for observability; this does not authorize the request.

## Open-source notification path

The recommended cloud-agnostic path is: services and middleware emit OTLP to the OpenTelemetry Collector; the Collector exports metrics in Prometheus format; Prometheus evaluates rules; Alertmanager routes to approved email, Webhook, PagerDuty-compatible, Slack-compatible, or incident-management receivers. Grafana reads Prometheus for dashboards. Wazuh may ingest normalized security events, while OpenCTI can receive threat-intelligence references. Notification endpoints and credentials remain outside telemetry payloads and are injected through secret management.

## Implementation boundary

The Collector configuration in `otel-collector-config.yaml` provides OTLP ingestion, Prometheus-compatible metrics, tenant normalization, batching, memory limits, and optional lakehouse export. Native middleware integration still requires each deployment to enable its supported OTLP exporter, client instrumentation, exporter/JMX endpoint, or custom adapter. Therefore, “OTel covers all middleware” is true as an architectural target and collection contract, but it is not truthful to claim that every listed component emits complete native OTel telemetry until its deployment-specific adapter and verification evidence are present.
