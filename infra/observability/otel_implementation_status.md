# OpenTelemetry Implementation Status

## Implemented in this change

| Area | Status | Evidence |
|---|---|---|
| Cloud-agnostic OTLP Collector | Implemented | `otel-collector-config.yaml` accepts OTLP gRPC/HTTP, applies memory/batch/resource processors, normalizes missing tenant attributes to `unknown`, exposes Prometheus metrics, and provides optional OTLP/HTTP lakehouse export. |
| Local Prometheus integration | Implemented | Prometheus scrapes Collector metrics and loads the TigerBeetle fail-closed rule file. |
| Local staging Compose | Implemented | Collector service, OTLP ports, health check, read-only config, and standard OTEL environment variables are present. |
| Go payment-engine | Implemented at HTTP boundary | OTLP trace provider, W3C propagation, HTTP instrumentation, bounded `tenant.id`, and clean shutdown are wired into process startup. |
| Python document-intelligence | Implemented at HTTP boundary | OTLP trace provider, FastAPI/HTTPX instrumentation, service resource metadata, bounded tenant/request attributes, and document hash/mime span attributes are wired. |
| E-04–E-09 evidence collection | Implemented | Explicit-runner collector captures only authorized staging outputs, hashes non-empty artifacts, records status, and fails closed on missing authorization, dirty checkout, missing runner, non-zero runner, or empty output. |
| TigerBeetle early-warning alerts | Implemented | Prometheus rules and deterministic rule tests exist for quorum loss, divergent views, consensus/fence safety, UNKNOWN growth, reconciliation mismatch, recovery, and missing telemetry. |

## Middleware coverage truth table

OpenTelemetry covers all listed middleware as an **observability architecture and integration contract**, but not every component emits native OTLP automatically. The following implementation modes are required:

- **Native SDK or client instrumentation:** Go, Rust, Python, Kafka clients, Temporal clients/workers, PostgreSQL clients, Redis clients, Mojaloop/FSPIOP clients, OpenSearch clients, and application HTTP/gRPC clients.
- **Sidecar or deployment exporter:** Dapr, APISIX, Keycloak events/metrics, OpenAppSec security events, Prometheus, and broker/server metrics.
- **Custom application spans:** Fluvio, TigerBeetle, Apache Sedona, GeoLibre, and lakehouse jobs where native OTLP support is absent or deployment-specific.
- **Collector ingestion/forwarding:** OTLP gRPC/HTTP, Prometheus scrape, normalized logs, and approved lakehouse OTLP export.

## Remaining production work

The Collector and service environment contract do not by themselves prove that every deployed middleware instance is exporting telemetry. Before regulatory or production GO, each component must have a deployment-specific configuration, a connectivity test, a redaction test, a tenant-propagation test where applicable, and retained evidence showing that the expected series/spans/logs arrived at the approved backend.

At the repository level, the Go payment-engine and Python document-intelligence boundaries are instrumented in code. Rust ledger-gateway, TypeScript control-plane, and the listed middleware still require their component-specific SDK/interceptor/plugin wiring and integration tests before they can be described as fully instrumented. The fail-closed alerting and Collector path are ready to receive that telemetry, but missing telemetry must remain an operational alert rather than being treated as healthy.

## Security and privacy controls

Telemetry must not contain access tokens, client secrets, private keys, raw documents, account numbers, payment payloads, AML case contents, SQL parameter values, geometry, or full identity claims. Tenant IDs must be authenticated and authorized by the application; the Collector’s `unknown` normalization is an observability fallback and never an authorization decision. Metric labels must be bounded to avoid unbounded tenant cardinality.
