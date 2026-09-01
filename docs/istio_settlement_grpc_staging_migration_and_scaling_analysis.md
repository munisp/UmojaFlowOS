# UmojaFlowOS Settlement gRPC: Istio Staging Migration and Scaling Analysis

**Status:** Staging migration procedure and benchmark analysis
**Date:** 2026-09-01
**Security posture:** Fail closed; do not enable live settlement traffic until every preflight and negative test passes.

## 1. Purpose and non-negotiable safety rules

This runbook migrates the internal settlement gRPC boundary to an Istio-protected staging path. It applies namespace-scoped `PeerAuthentication` in `STRICT` mode, an allowlisted `AuthorizationPolicy`, an internal gRPC `ServiceEntry`, and an `ISTIO_MUTUAL` `DestinationRule`. Istio uses workload identity extracted from mutual TLS for `source.principal`; the policy must therefore match the actual Kubernetes service-account identities, not application-supplied headers [1]. `STRICT` mode is intended to prevent connections that bypass the mesh [2].

> **Fail-closed rule:** If the namespace, workload selector, gRPC port, service account principal, sidecar status, certificate chain, policy analysis, or negative authorization result is ambiguous, stop the migration and keep settlement traffic disabled.

The current repository contains an important topology mismatch. The policy file uses namespace `umoja` and principals under `cluster.local/ns/umoja`, while the payment-engine deployment is in namespace `umoja-payment` and the existing network policy refers to callers in `umoja-control`. Applying the current file unchanged would not protect the intended workload. Do not “fix” this with an unreviewed broad selector. Resolve the namespace and service-account identities in staging first, then render the policy from verified values.

## 2. Required staging inputs

| Input | Required value or evidence | Stop condition |
|---|---|---|
| Kubernetes context | Approved staging context and cluster identity | Context is missing or points to production |
| Istio control plane | Healthy, supported revision, sidecar injection enabled | `istiod` or ingress/egress gateways unhealthy |
| Target namespace | The namespace containing the payment-engine Deployment | Namespace differs from the approved change record |
| Target workload | `app.kubernetes.io/name=payment-engine` | Selector matches zero or unintended workloads |
| gRPC listener | Payment-engine exposes and listens on `8443` | Service or pods expose only HTTP `8081` |
| Caller identities | Exact service-account principals for control-plane and reconciliation worker | Identity cannot be proven from pod metadata and mTLS |
| TLS mode | Mesh-managed `ISTIO_MUTUAL`; application mTLS as separately approved | Plaintext path or unknown certificate issuer |
| Change approvals | Platform, security, compliance, and release owner approvals | Any required approval absent |

The current payment-engine Kubernetes manifest exposes only port `8081` and does not show a settlement gRPC listener or gRPC certificate configuration. The application runtime must be deployed with its gRPC listener and server TLS configuration before this policy migration. Istio policy application alone does not create a listener.

## 3. Preflight and namespace identity discovery

Run all commands from a workstation with the approved staging kubeconfig. Never place credentials, bearer tokens, private keys, or certificate contents in logs.

```bash
set -Eeuo pipefail
export NS=umoja-payment
export APP=payment-engine
export STAGING_CONTEXT='REPLACE_WITH_APPROVED_CONTEXT'
kubectl config use-context "$STAGING_CONTEXT"
kubectl cluster-info
kubectl get ns "$NS" -o jsonpath='{.metadata.name}{"\n"}'
kubectl -n "$NS" get deploy,svc,pods -l app.kubernetes.io/name="$APP" -o wide
kubectl -n "$NS" get deploy "$APP" -o jsonpath='{.spec.template.spec.serviceAccountName}{"\n"}'
kubectl -n "$NS" get pods -l app.kubernetes.io/name="$APP" \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.metadata.annotations.sidecar\.istio\.io/status}{"\n"}{end}'
istioctl version
istioctl proxy-status
```

Record the output in the approved evidence store. The expected result is three ready payment-engine replicas, each with an Envoy sidecar, and a healthy control plane. If `kubectl` or `istioctl` is unavailable, this procedure is not complete; the local synthetic test evidence cannot be promoted as live mesh evidence.

Confirm the Service and pod ports before applying policy:

```bash
kubectl -n "$NS" get svc "$APP" -o yaml
kubectl -n "$NS" get deploy "$APP" -o jsonpath='{range .spec.template.spec.containers[?(@.name=="payment-engine")].ports[*]}{.name}{"\t"}{.containerPort}{"\n"}{end}'
kubectl -n "$NS" get endpointslice -l kubernetes.io/service-name="$APP" -o yaml
```

The gRPC Service must expose a named port such as `grpc-tls` on `8443`, and the pod must be listening on the corresponding target port. A Service with only `8081` is a hard blocker.

Discover the exact caller service accounts and namespaces rather than assuming names:

```bash
kubectl get pods -A -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,SA:.spec.serviceAccountName' \
  | grep -E 'control|recon|payment'
kubectl get deploy -A -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,SA:.spec.template.spec.serviceAccountName' \
  | grep -E 'control|recon|payment'
```

Construct principals only after review:

```text
cluster.local/ns/<verified-caller-namespace>/sa/<verified-caller-service-account>
```

## 4. Render a staging-specific policy

Do not apply `infra/service-mesh/settlement-grpc-mtls.yaml` unchanged until its namespace and principals are reconciled with the discovery output. Create a reviewed staging rendering with these values:

```yaml
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: settlement-grpc-strict-mtls
  namespace: <PAYMENT_ENGINE_NAMESPACE>
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: payment-engine
  mtls:
    mode: STRICT
---
apiVersion: security.istio.io/v1beta1
kind: AuthorizationPolicy
metadata:
  name: settlement-grpc-allowlisted-callers
  namespace: <PAYMENT_ENGINE_NAMESPACE>
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: payment-engine
  action: ALLOW
  rules:
  - from:
    - source:
        principals:
        - cluster.local/ns/<CONTROL_NAMESPACE>/sa/<CONTROL_SERVICE_ACCOUNT>
        - cluster.local/ns/<RECONCILIATION_NAMESPACE>/sa/<RECONCILIATION_SERVICE_ACCOUNT>
    to:
    - operation:
        ports: ["8443"]
        methods: ["POST"]
---
apiVersion: networking.istio.io/v1beta1
kind: ServiceEntry
metadata:
  name: settlement-grpc
  namespace: <PAYMENT_ENGINE_NAMESPACE>
spec:
  hosts:
  - payment-engine.<PAYMENT_ENGINE_NAMESPACE>.svc.cluster.local
  location: MESH_INTERNAL
  ports:
  - number: 8443
    name: grpc-tls
    protocol: GRPC
  resolution: DNS
---
apiVersion: networking.istio.io/v1beta1
kind: DestinationRule
metadata:
  name: settlement-grpc-mtls
  namespace: <PAYMENT_ENGINE_NAMESPACE>
spec:
  host: payment-engine.<PAYMENT_ENGINE_NAMESPACE>.svc.cluster.local
  trafficPolicy:
    tls:
      mode: ISTIO_MUTUAL
    connectionPool:
      http:
        http2MaxRequests: 1000
        maxRequestsPerConnection: 1000
      tcp:
        maxConnections: 200
    outlierDetection:
      consecutive5xxErrors: 3
      interval: 5s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
```

An explicit `ALLOW` policy establishes the permitted callers for the selected workload; Istio authorization policy supports `ALLOW`, `DENY`, and `CUSTOM` actions [3]. Review policy precedence and default-deny behavior before adding any other policy in the namespace [4]. The `methods: ["POST"]` constraint is appropriate for the gRPC HTTP/2 method transport, but validate the effective Envoy route in staging rather than assuming the manifest alone proves it.

## 5. Dry-run and static validation

Save the reviewed rendering as `artifacts/staging/settlement-grpc-mtls-staging.yaml` and validate it without changing the cluster:

```bash
kubectl apply --dry-run=server -f artifacts/staging/settlement-grpc-mtls-staging.yaml
istioctl validate -f artifacts/staging/settlement-grpc-mtls-staging.yaml
istioctl analyze -n "$NS" artifacts/staging/settlement-grpc-mtls-staging.yaml
kubectl diff -f artifacts/staging/settlement-grpc-mtls-staging.yaml
```

`istioctl analyze` is designed to detect configuration issues affecting mesh resources [5]. A warning affecting namespace, selector, host, port, principal, or policy reachability is a stop condition. Capture the exact dry-run output as evidence.

## 6. Canary migration sequence

Apply the migration during an approved staging window. First deploy the payment-engine version that exposes gRPC `8443`, wait for readiness, and confirm the legacy HTTP route remains unchanged for rollback. Then apply the policy bundle:

```bash
kubectl -n "$NS" rollout status deploy/payment-engine --timeout=5m
kubectl apply -f artifacts/staging/settlement-grpc-mtls-staging.yaml --server-side --field-manager=umoja-istio-migration
kubectl -n "$NS" get peerauthentication,authorizationpolicy,serviceentry,destinationrule
istioctl analyze -n "$NS"
istioctl proxy-config listeners deploy/payment-engine -n "$NS" | grep -E '8443|grpc'
istioctl proxy-config clusters deploy/payment-engine -n "$NS" | grep -E 'payment-engine|8443'
```

Start with one canary replica if the Deployment strategy allows it. Route only synthetic, non-financial test traffic to the gRPC path. Do not submit real customer payments during policy validation. Monitor gRPC error rate, deadline exceeded, TLS/auth failures, Envoy denied requests, pod restarts, CPU, memory, connection count, and OTel tenant-safe metrics for at least the approved observation interval.

## 7. Positive and negative verification matrix

The test matrix must prove both authentication and authorization. A successful TCP connection is not sufficient evidence.

| Test | Expected result | Evidence command or artifact |
|---|---|---|
| Allowlisted control-plane service account with mesh mTLS | gRPC Execute/Query succeeds | Cross-service test log and Envoy access log |
| Allowlisted reconciliation-worker service account | gRPC Query succeeds according to role scope | Cross-service test log |
| Unallowlisted service account | `PERMISSION_DENIED` / Envoy RBAC denial | Negative test log and `istioctl proxy-config` evidence |
| Missing client workload identity | TLS/mesh handshake denied | Client error plus Envoy log |
| Plaintext direct pod-to-pod call | Rejected under STRICT | Direct-call negative test |
| Wrong namespace principal | Rejected | Negative test log |
| Wrong port or non-gRPC HTTP call to 8443 | Rejected or non-success | Negative test log |
| Expired or invalid application certificate, if app-level mTLS is enabled | TLS handshake failure | Sanitized handshake evidence |
| Valid app-level mTLS certificate | Handshake succeeds and request is authorized | Sanitized certificate subject/issuer and test log |

Use a temporary diagnostic pod with a known service account for negative testing. Do not grant it the allowlisted identity merely to make a test pass. Inspect effective Envoy configuration:

```bash
istioctl authn tls-check <caller-pod>.<caller-namespace> payment-engine.$NS.svc.cluster.local
istioctl proxy-config authz deploy/payment-engine -n "$NS"
kubectl -n "$NS" logs deploy/payment-engine -c istio-proxy --since=15m | grep -Ei 'rbac|denied|tls|handshake|grpc'
```

## 8. Rollback procedure

Rollback is triggered by any unexplained settlement error, elevated `UNKNOWN` state, TLS failure, unintended denial of an allowlisted caller, unintended acceptance of a caller, sidecar instability, or loss of tenant-safe telemetry. Preserve the original idempotency key and do not resubmit an ambiguous payment through another route.

```bash
kubectl delete -f artifacts/staging/settlement-grpc-mtls-staging.yaml
kubectl -n "$NS" rollout undo deploy/payment-engine --to-revision=<APPROVED_PRIOR_REVISION>
kubectl -n "$NS" rollout status deploy/payment-engine --timeout=5m
istioctl analyze -n "$NS"
```

If deletion is not authorized under the change plan, use the approved version-controlled rollback commit rather than ad hoc edits. Confirm that the legacy path is healthy before restoring traffic. Reconciliation must resolve any in-flight `UNKNOWN` state before a release is marked recovered.

## 9. Required evidence bundle

The immutable staging evidence bundle must include the approved change record, rendered YAML and SHA-256 digest, server-side dry-run output, `istioctl validate` and `istioctl analyze` output, pre/post `proxy-status`, listener and cluster configuration, positive and negative test logs, sanitized mTLS handshake evidence, Envoy denial evidence, OTel metrics/traces with tenant isolation, benchmark output, incident/rollback records if applicable, and the release SHA. Bind the bundle to the existing four-role release approval process.

## 10. Scaling analysis: 4 versus 16 workers under 10 ms injected latency

The benchmark reused one gRPC connection and injected a fixed 10 ms sleep in the server handler. Three samples were recorded per worker setting:

| Workers | Samples (ms/op) | Median (ms/op) | Approx. throughput | Relative to 4 workers |
|---:|---:|---:|---:|---:|
| 1 | 10.661, 10.643, 10.587 | **10.643** | **94 ops/s** | 0.25x |
| 4 | 2.688, 2.682, 2.675 | **2.682** | **373 ops/s** | 1.00x |
| 16 | 0.684, 0.685, 0.684 | **0.684** | **1,462 ops/s** | **3.92x** |

Moving from four to sixteen workers increased throughput by approximately **3.92x**, or about **98% of ideal 4x scaling**. The measured result therefore does not show a material saturation bottleneck between these points. The 16-worker result is faster per operation because the benchmark reports wall-clock time per concurrent operation while multiple handler sleeps overlap; it must not be interpreted as an individual request completing in less than the injected 10 ms service time.

The dominant behavior is concurrency hiding the fixed service latency. At one worker, the operation is close to the 10 ms injected delay plus transport overhead. At four workers, four independent requests overlap, reducing aggregate time per operation to roughly one quarter. At sixteen workers, overlap continues, but the improvement is slightly below ideal scaling, indicating small overhead from gRPC scheduling, HTTP/2 stream coordination, TLS record processing, protobuf marshaling, and benchmark synchronization.

The current data does **not** identify a hard bottleneck. It suggests the next bottleneck will likely appear only at higher concurrency or under a real sidecar. Candidate limits are Envoy HTTP/2 stream and connection limits, server CPU and Go scheduler contention, per-request allocations (the earlier pooled run reported roughly 10–11 KB and 158–179 allocations per operation), kernel socket buffers, mesh telemetry/export overhead, and downstream coordinator/database/provider capacity. The configured `http2MaxRequests: 1000`, `maxRequestsPerConnection: 1000`, and `maxConnections: 200` are ceilings rather than proof that the deployed system can sustain those values.

The next capacity experiment should measure requests per second and p50/p95/p99 latency at 1, 4, 16, 32, 64, 128, and 256 workers with at least two pooled connections, real Istio sidecars, representative payload sizes, TLS termination, OTel enabled, CPU/memory limits equal to staging, and a controlled provider stub. Record Envoy `upstream_cx_active`, HTTP/2 stream counts, connection reuse, CPU throttling, Go GC pauses, allocations, server queueing, database pool wait time, and error/UNKNOWN rates. A performance regression gate should use tail latency and error budget, not only `ns/op`.

## References

[1]: https://istio.io/latest/docs/concepts/security/ "Istio Security Concepts"

[2]: https://istio.io/latest/docs/reference/config/security/peer_authentication/ "Istio PeerAuthentication Reference"

[3]: https://istio.io/latest/docs/reference/config/security/authorization-policy/ "Istio AuthorizationPolicy Reference"

[4]: https://istio.io/latest/docs/ops/best-practices/security/ "Istio Security Best Practices"

[5]: https://istio.io/latest/docs/ops/diagnostic-tools/istioctl-analyze/ "Istio Configuration Analysis with istioctl analyze"
