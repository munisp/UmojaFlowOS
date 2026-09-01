# Istio-protected Settlement gRPC: 32–256 Worker Test Plan and Namespace Migration Runbook

**Environment:** staging only
**Scope:** payment-engine settlement gRPC listener, Istio sidecars, OTel Collector, Prometheus/Tempo, and caller authorization
**Security posture:** fail closed; no customer-value or unrestricted provider execution during this test
**Date:** 2026-09-01

## 1. Objectives and acceptance decision

This runbook has two objectives. First, it defines a repeatable capacity test at **32, 64, 128, and 256 concurrent workers** with full Istio sidecar injection and OTel telemetry. Second, it resolves the repository’s `umoja` versus `umoja-payment` namespace inconsistency and adds the missing payment-engine Service and pod port for settlement gRPC on `8443`.

The test is a **GO** only when the gRPC path remains authenticated, authorized, observable, and fail closed at every worker level. A throughput increase is not sufficient for approval. A single unexpected authorization acceptance, trace-tenant leak, TLS downgrade, elevated `UNKNOWN` result, dropped telemetry rate above the approved threshold, or unbounded CPU/memory condition is a **NO-GO**.

## 2. Current mismatch and definitive target topology

The existing payment-engine Kubernetes manifest declares namespace `umoja-payment`, while the existing Istio policy declares namespace `umoja`. The existing network policy references `umoja-control` for control-plane ingress. The canonical staging target in this runbook is therefore:

| Object | Canonical staging value |
|---|---|
| Payment-engine namespace | `umoja-payment` |
| Payment-engine workload selector | `app.kubernetes.io/name: payment-engine` |
| Payment-engine Service | `payment-engine.umoja-payment.svc.cluster.local` |
| Legacy HTTP port | `8081` |
| Settlement gRPC port | `8443`, named `grpc-tls` |
| Control-plane principal | `cluster.local/ns/umoja-control/sa/control-plane` |
| Reconciliation principal | `cluster.local/ns/umoja-payment/sa/reconciliation-worker` |
| Peer authentication | `STRICT` for selected payment-engine workload |
| Destination TLS | `ISTIO_MUTUAL` |
| OTel endpoint | `otel-collector.observability.svc.cluster.local:4317` |

The two caller service accounts must be verified in the live cluster before application. If either identity differs, do not broaden the policy; update the reviewed staging rendering and record the identity discovery evidence.

## 3. Repository configuration to apply

### 3.1 Corrected Istio policy bundle

The exact corrected policy bundle is stored at:

```text
infra/service-mesh/settlement-grpc-mtls-staging.yaml
```

It applies `PeerAuthentication`, `AuthorizationPolicy`, `ServiceEntry`, and `DestinationRule` in `umoja-payment`. The allowlist is restricted to the two verified service-account principals and port `8443`. The policy is intentionally not applied to namespace `umoja`.

### 3.2 Kubernetes overlay for the missing gRPC port

The exact Kustomize overlay is stored at:

```text
infra/kubernetes/payment-engine-grpc-staging-overlay/
├── kustomization.yaml
├── service-grpc-port.patch.yaml
└── deployment-grpc-port-and-tls.patch.yaml
```

The overlay keeps HTTP `8081` for rollback, adds `grpc-tls` on `8443`, enables sidecar injection, mounts the server certificate secret, and sets the OTel exporter endpoint. The secret `settlement-grpc-server-mtls` must be provisioned by the approved secret manager or ExternalSecret process; private key material must not be committed or printed.

**Important application prerequisite:** Kubernetes YAML cannot create a listening socket. The payment-engine binary must be built with runtime wiring that reads `GRPC_SETTLEMENT_LISTEN_ADDR`, `GRPC_SETTLEMENT_CA_FILE`, `GRPC_SETTLEMENT_CERT_FILE`, and `GRPC_SETTLEMENT_KEY_FILE`, loads `LoadGRPCServerTLSConfig`, registers the generated settlement service, and serves gRPC on `8443` concurrently with HTTP `8081`. If the binary does not implement this listener, the overlay must not be promoted and the release remains NO-GO.

## 4. Preflight safety and identity checks

Use a dedicated staging kubeconfig and an approved context. The following checks must produce evidence before any policy is applied:

```bash
set -Eeuo pipefail
export STAGING_CONTEXT='REPLACE_WITH_APPROVED_STAGING_CONTEXT'
export PAYMENT_NS=umoja-payment
export CONTROL_NS=umoja-control
export PAYMENT_APP=payment-engine
kubectl config use-context "$STAGING_CONTEXT"
kubectl cluster-info
kubectl get ns "$PAYMENT_NS" "$CONTROL_NS"
kubectl -n "$PAYMENT_NS" get deploy,svc,pods -l app.kubernetes.io/name="$PAYMENT_APP" -o wide
kubectl -n "$PAYMENT_NS" get deploy "$PAYMENT_APP" -o jsonpath='{.spec.template.spec.serviceAccountName}{"\n"}'
kubectl -n "$PAYMENT_NS" get pods -l app.kubernetes.io/name="$PAYMENT_APP" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.metadata.annotations.sidecar\.istio\.io/status}{"\n"}{end}'
kubectl -n "$CONTROL_NS" get deploy control-plane -o jsonpath='{.spec.template.spec.serviceAccountName}{"\n"}'
kubectl -n "$PAYMENT_NS" get deploy reconciliation-worker -o jsonpath='{.spec.template.spec.serviceAccountName}{"\n"}'
istioctl version
istioctl proxy-status
```

Stop if the context is not the approved staging cluster, if the caller Deployments do not exist, if service-account names differ from the reviewed policy, or if any payment-engine pod lacks an injected sidecar.

Verify the gRPC runtime and Service before policy application:

```bash
kubectl -n "$PAYMENT_NS" get svc payment-engine -o jsonpath='{range .spec.ports[*]}{.name}{"\t"}{.port}{"\t"}{.targetPort}{"\n"}{end}'
kubectl -n "$PAYMENT_NS" get deploy payment-engine -o jsonpath='{range .spec.template.spec.containers[?(@.name=="payment-engine")].ports[*]}{.name}{"\t"}{.containerPort}{"\n"}{end}'
kubectl -n "$PAYMENT_NS" get secret settlement-grpc-server-mtls -o jsonpath='{.data.ca\.crt}' | base64 -d | openssl x509 -noout -subject -issuer -dates
kubectl -n "$PAYMENT_NS" exec deploy/payment-engine -c payment-engine -- sh -c 'command -v ss >/dev/null && ss -ltn || true'
```

The expected Service and container output includes `grpc-tls 8443 grpc-tls`. A missing listener, missing secret, or certificate whose issuer is not the approved staging CA is a hard stop.

## 5. Dry-run and apply sequence

First validate the overlay and policy without changing the cluster:

```bash
kustomize build --load-restrictor LoadRestrictionsNone \
  infra/kubernetes/payment-engine-grpc-staging-overlay \
  > artifacts/staging/payment-engine-grpc-staging-rendered.yaml
kubectl apply --dry-run=server -f artifacts/staging/payment-engine-grpc-staging-rendered.yaml
kubectl apply --dry-run=server -f infra/service-mesh/settlement-grpc-mtls-staging.yaml
istioctl validate -f infra/service-mesh/settlement-grpc-mtls-staging.yaml
istioctl analyze -n "$PAYMENT_NS" infra/service-mesh/settlement-grpc-mtls-staging.yaml
kustomize build --load-restrictor LoadRestrictionsNone \
  infra/kubernetes/payment-engine-grpc-staging-overlay \
  > /tmp/payment-engine-grpc-staging-rendered.yaml
kubectl diff -f /tmp/payment-engine-grpc-staging-rendered.yaml
kubectl diff -f infra/service-mesh/settlement-grpc-mtls-staging.yaml
```

Apply the application overlay first so the Service and listener exist, then wait for readiness:

```bash
kubectl apply -k infra/kubernetes/payment-engine-grpc-staging-overlay
kubectl -n "$PAYMENT_NS" rollout status deploy/payment-engine --timeout=10m
kubectl -n "$PAYMENT_NS" wait --for=condition=available deploy/payment-engine --timeout=10m
istioctl proxy-status
```

Apply the Istio bundle only after the listener and sidecars are ready:

```bash
kubectl apply --server-side --field-manager=umoja-staging-mesh \
  -f infra/service-mesh/settlement-grpc-mtls-staging.yaml
kubectl -n "$PAYMENT_NS" get peerauthentication,authorizationpolicy,serviceentry,destinationrule
istioctl analyze -n "$PAYMENT_NS"
istioctl proxy-config listeners deploy/payment-engine -n "$PAYMENT_NS" | grep -E '8443|grpc'
istioctl proxy-config clusters deploy/payment-engine -n "$PAYMENT_NS" | grep -E 'payment-engine|8443'
istioctl proxy-config authz deploy/payment-engine -n "$PAYMENT_NS"
```

## 6. Full-sidecar and OTel test preparation

The load generator must itself be injected into the mesh and run under a **non-allowlisted** service account unless it is explicitly the control-plane or reconciliation-worker test identity. This prevents the load test from accidentally bypassing authorization.

Deploy a test workload with:

```yaml
metadata:
  labels:
    app.kubernetes.io/name: settlement-grpc-loadgen
  annotations:
    sidecar.istio.io/inject: "true"
    traffic.sidecar.istio.io/includeOutboundPorts: "8443,4317"
```

Configure the test run with a stable synthetic tenant identifier per worker cohort, but do not use real customer identifiers. OTel must emit:

```text
OTEL_SERVICE_NAME=settlement-grpc-loadgen
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.observability.svc.cluster.local:4317
OTEL_EXPORTER_OTLP_PROTOCOL=grpc
OTEL_RESOURCE_ATTRIBUTES=service.namespace=umojaflowos,deployment.environment=staging
```

For the benchmark observation window, use 100% trace sampling only if the collector and storage capacity test has been approved. Otherwise use the approved staging sample rate and record it. Never attach raw payment payloads, account numbers, wallet addresses, credentials, or document contents to spans. Tenant identity must be a bounded, authorization-controlled attribute or a one-way test identifier.

Before load, establish telemetry baselines:

```bash
kubectl -n observability get pods,svc otel-collector prometheus tempo
kubectl -n observability port-forward svc/prometheus 19090:9090 >/tmp/prometheus-port-forward.log 2>&1 &
PROM_PID=$!
trap 'kill "$PROM_PID" 2>/dev/null || true' EXIT
curl -fsS http://127.0.0.1:19090/-/ready
curl -fsS http://127.0.0.1:19090/api/v1/query \
  --data-urlencode 'query=up{job=~"otel|payment-engine|istio.*"}'
```

Record OTel Collector accepted, refused, dropped, and export-failed spans/metrics; Envoy request count, response codes, active connections, HTTP/2 streams, and upstream reset counters; payment-engine CPU, memory, GC, goroutines, request latency, and `UNKNOWN` outcomes; and collector/Prometheus/Tempo resource use.

## 7. Worker-limit test matrix

Run each level in a fresh, reproducible staging window. Use a 10 ms controlled upstream/service latency budget for the first pass, then repeat at 0 ms and the approved worst-case latency. Each level requires a warm-up, a steady-state sample, and a cool-down.

| Level | Warm-up | Measurement | Minimum duration | Required repetitions |
|---:|---:|---:|---:|---:|
| 32 | 60 s | 5 min | 6 min | 3 |
| 64 | 60 s | 5 min | 6 min | 3 |
| 128 | 90 s | 10 min | 11.5 min | 3 |
| 256 | 120 s | 10 min | 12 min | 3 |

The test must reuse a bounded connection pool rather than opening a connection per request. Start with two pooled HTTP/2 connections and repeat with the production target. Keep payload size, request mix, tenant distribution, timeout, and server response behavior constant across worker levels. The load generator must use the original idempotency identity for retries and must not submit real value.

A generic `ghz` execution shape is:

```bash
ghz --insecure=false \
  --cacert=/run/secrets/mesh/ca.crt \
  --cert=/run/secrets/mesh/client.crt \
  --key=/run/secrets/mesh/client.key \
  --call=umoja.settlement.v1.Settlement/Execute \
  --data-file=/run/config/settlement-request.json \
  --concurrency=32 --connections=2 --duration=5m \
  payment-engine.umoja-payment.svc.cluster.local:8443 \
  | tee /artifacts/ghz-workers-32.json
```

Repeat with `--concurrency=64`, `128`, and `256`. If mesh-managed `ISTIO_MUTUAL` is used, the load generator should normally call the service through Envoy using the approved in-mesh identity rather than supplying application certificates directly. Do not combine an unapproved direct certificate path with mesh identity and call the result “full Istio” evidence.

For every run, collect:

```bash
kubectl -n "$PAYMENT_NS" top pods -l app.kubernetes.io/name=payment-engine
kubectl -n "$PAYMENT_NS" exec deploy/payment-engine -c istio-proxy -- pilot-agent request GET stats | \
  grep -E 'upstream_cx_active|upstream_cx_total|upstream_rq_total|upstream_rq_pending|upstream_rq_timeout|upstream_cx_destroy|downstream_cx_active'
kubectl -n "$PAYMENT_NS" logs deploy/payment-engine -c istio-proxy --since=15m | \
  grep -Ei 'rbac|denied|tls|handshake|grpc|reset|upstream'
istioctl proxy-status
```

## 8. Pass/fail criteria

The worker level passes only if all criteria below hold for all three repetitions:

| Category | Acceptance condition |
|---|---|
| Correctness | 100% of synthetic requests have a valid typed response and payload digest; zero duplicate terminal decisions |
| Authorization | Allowlisted identities succeed; unallowlisted, wrong-namespace, and plaintext calls are denied |
| Authentication | All accepted calls use the expected mesh identity and `STRICT` mTLS; no TLS downgrade |
| Reliability | No unexplained `UNKNOWN` increase, server error storm, connection reset storm, or retry amplification |
| Telemetry | OTel trace/metric export failures remain below approved threshold and tenant attributes remain isolated |
| Capacity | p95/p99 latency, error rate, CPU throttling, memory, goroutines, GC, Envoy streams, and collector queues remain within approved staging limits |
| Recovery | After load stops, queues, active streams, Envoy connections, and telemetry exporter backlog return to baseline within the approved recovery interval |

Do not use only average `ns/op` as an acceptance metric. The prior local test’s sub-10 ms concurrent timings were aggregate wall-clock timings caused by overlapping a fixed 10 ms handler delay; they were not individual request latency.

## 9. Bottleneck diagnosis at 32–256 workers

Interpret each saturation pattern as follows:

| Observation | Likely bottleneck | Confirmatory measurement | Mitigation |
|---|---|---|---|
| Envoy pending requests rise while payment-engine CPU is low | HTTP/2 stream or connection ceiling | Envoy pending/active streams and `maxRequestsPerConnection` | Increase only after capacity review; use multiple pooled connections |
| Payment-engine CPU reaches limit, p99 rises, allocations increase | Go scheduling, protobuf/TLS CPU, or application handler | CPU throttling, goroutines, GC pause, allocations | Tune CPU requests/limits, reduce allocations, profile before changing limits |
| Collector queues/export failures rise while service is healthy | OTel backpressure | collector queue size, refused spans, export failures | Batch/queue tuning, sampling adjustment, collector horizontal scaling |
| Postgres/TigerBeetle waits rise | Downstream settlement boundary | pool wait, DB latency, ledger response latency | bound concurrency at coordinator; never bypass idempotency |
| `UNKNOWN` rises during sidecar ejection or timeout | Ambiguous provider/mesh outcome | coordinator state, Envoy resets, timeout metrics | hold settlement; reconcile before retry; do not fail over blindly |
| Authorization denials rise only for valid callers | principal or namespace mismatch | `istioctl authz check`, proxy config, service-account identity | correct exact principal in reviewed policy; never use wildcard |
| 256 workers cause connection churn | pool or sidecar connection limits | `upstream_cx_total`, connection destroy reasons | reuse pooled connections, tune bounded pool and HTTP/2 limits |

Expected scaling should be evaluated from throughput and p95/p99 latency. The 4-to-16 local result was close to ideal throughput scaling, so the important question at 32–256 is where tail latency, queueing, OTel backpressure, or downstream capacity begins to diverge.

## 10. Negative authorization and fail-closed checks

Run the enhanced manifest and live security harness before and after each load level. The allowlisted test pod must contain `grpcurl`, the typed protobuf file, a synthetic request JSON file, and the approved client CA/certificate/key at the paths passed to the harness. The denied pod must use a non-allowlisted service account. The command below performs a real typed `Settlement/Execute` call from the allowlisted pod, checks TLS/authz configuration, performs an unallowlisted plaintext probe, and requires structured Envoy JSON access-log records showing both HTTP 200 allow and HTTP 403 RBAC deny:

```bash
python3 scripts/infra/test_settlement_grpc_staging_security.py \\
  --live \\
  --namespace umoja-payment \\
  --allowed-pod settlement-grpc-loadgen \\
  --allowed-namespace umoja-control \\
  --allowed-container grpcurl \\
  --denied-pod settlement-grpc-denied \\
  --denied-namespace umoja-payment \\
  --denied-container grpcurl \\
  --tls-ca /run/secrets/settlement/ca.crt \\
  --tls-cert /run/secrets/settlement/client.crt \\
  --tls-key /run/secrets/settlement/client.key \\
  --request-file /run/config/settlement-request.json \\
  --proto /run/config/settlement.proto
```

The live test is a hard gate: it fails if the allowlisted typed call is not a successful RPC, if the response contains `PERMISSION_DENIED` or `UNAUTHENTICATED`, if the plaintext denied call succeeds, if the denial lacks an explicit `PERMISSION_DENIED`, `403`, or `RBAC` signal, or if the payment-engine Envoy sidecar emits no structured JSON access logs with a 200 allow and a 403 RBAC denial.

Run these tests before and after each load level:

```bash
# Wrong principal: must be denied by Envoy RBAC.
kubectl -n umoja-payment run grpc-denied --rm -it --restart=Never \
  --image=REVIEWED_GRPC_TEST_IMAGE --overrides='{"metadata":{"annotations":{"sidecar.istio.io/inject":"true"}}}' \
  -- grpcurl -plaintext payment-engine.umoja-payment.svc.cluster.local:8443 \
  umoja.settlement.v1.Settlement/Query

# Inspect effective authorization and TLS configuration.
istioctl x authz check deploy/payment-engine -n umoja-payment
istioctl authn tls-check grpc-denied.umoja-payment payment-engine.umoja-payment.svc.cluster.local
```

The actual negative test image and service-account identity must be approved before use. A successful direct plaintext call, a successful wrong-principal call, or an inability to prove the call was denied is a NO-GO.

## 11. Rollback

If any gate fails, stop the load generator, preserve evidence, and roll back through the approved change revision:

```bash
kubectl delete -f infra/service-mesh/settlement-grpc-mtls-staging.yaml
kubectl apply -k infra/kubernetes/payment-engine-grpc-staging-overlay
kubectl -n umoja-payment rollout status deploy/payment-engine --timeout=10m
kubectl -n umoja-payment get svc payment-engine
istioctl analyze -n umoja-payment
```

Do not delete or recreate idempotency records, ledger entries, or provider submissions as part of mesh rollback. Any `UNKNOWN` settlement state must be reconciled before the incident is closed.

## 12. Evidence package

Store the rendered YAML and SHA-256 digest, context/cluster identity, identity discovery output, dry-run and `istioctl` validation output, rollout history, sidecar status, listener/cluster/authz configuration, certificate subject/issuer/validity evidence, every worker-level load result, Prometheus queries, OTel Collector logs, Tempo trace query evidence, Envoy stats, resource profiles, negative-test logs, rollback evidence, and the release SHA. Bind the package to the existing four-role approval and immutable evidence process.

## References

[1]: https://istio.io/latest/docs/concepts/security/ "Istio Security Concepts"

[2]: https://istio.io/latest/docs/reference/config/security/peer_authentication/ "Istio PeerAuthentication Reference"

[3]: https://istio.io/latest/docs/reference/config/security/authorization-policy/ "Istio AuthorizationPolicy Reference"

[4]: https://istio.io/latest/docs/ops/diagnostic-tools/istioctl-analyze/ "Istio Configuration Analysis with istioctl analyze"
