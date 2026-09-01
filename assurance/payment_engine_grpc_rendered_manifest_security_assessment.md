# Payment-Engine gRPC Staging Manifest Security Assessment

**Assessment date:** 2026-09-01
**Scope:** `artifacts/staging/payment-engine-grpc-staging-rendered.yaml`, `infra/service-mesh/settlement-grpc-mtls-staging.yaml`, and the payment-engine gRPC startup wiring
**Assessment posture:** Static controls validated; live Kubernetes/Istio conformance remains unverified because no cluster is attached to this environment.

## Executive assessment

The rendered configuration is structurally improved and correctly reconciles the payment-engine namespace to `umoja-payment`. It exposes the named `grpc-tls` Service and container port on `8443`, mounts a dedicated server certificate secret, enables explicit sidecar injection, sets `STRICT` peer authentication in the corrected policy bundle, and restricts gRPC authorization to two exact workload principals. The automated static harness passed all of these invariants.

The configuration is **not yet production-ready evidence** by itself. Kubernetes admission, Pod Security admission, Secret delivery, Istio sidecar injection, Envoy effective authorization, certificate chain validation, OTel Collector reachability, and live plaintext-denial behavior must be proven in the approved staging cluster. The payment-engine listener intentionally starts with `GRPC_SETTLEMENT_EXECUTION_ENABLED=false` and returns fail-closed `UNKNOWN` until the real settlement coordinator is composed into the binary.

## Control assessment

| Control area | Result | Assessment |
|---|---:|---|
| Namespace consistency | PASS | Rendered workload and corrected Istio objects use `umoja-payment`; old `umoja` policy remains a legacy file and must not be applied unchanged. |
| Workload selector scope | PASS | Selector targets `app.kubernetes.io/name=payment-engine`; live cluster must prove it matches only intended replicas. |
| gRPC exposure | PASS | Service and container expose named `grpc-tls` on `8443`; runtime binary now binds configured listener. |
| Application TLS | PASS/CONDITIONAL | TLS 1.3 and client certificate verification are enforced by Go startup code; staging must prove the mounted certificate chain and SAN. |
| Mesh mTLS | CONFIGURED | `PeerAuthentication` is `STRICT` and `DestinationRule` uses `ISTIO_MUTUAL`; live proxy evidence is still required. |
| Authorization | CONFIGURED/PASS STATIC | Exact principals and port/method restriction pass static validation; live `PermissionDenied` and allowlist tests remain required. |
| Secret handling | CONDITIONAL | Secret is mounted read-only with restrictive mode; secret-manager delivery, rotation, and absence behavior require live validation. |
| Pod hardening | PASS STATIC | Non-root UID, restricted security labels, dropped capabilities, no privilege escalation, read-only root filesystem, and RuntimeDefault seccomp are rendered. |
| Network segmentation | CONDITIONAL | Existing NetworkPolicy preserves signer and DNS egress but must be reviewed for OTel egress and gRPC caller ingress in the live namespace. |
| OTel telemetry | CONFIGURED | OTLP gRPC endpoint and staging resource attributes are rendered; export success and tenant-safe attributes require collector evidence. |
| Availability | CONDITIONAL | Three replicas and rolling update settings are rendered; PDB, topology spread, and disruption behavior are not shown in the rendered output and should be added or evidenced. |
| Supply chain | CONDITIONAL | Image uses `RELEASE_SHA` placeholder; deployment must resolve an immutable digest and verify signature/provenance. |
| Runtime settlement safety | PASS FAIL-CLOSED | Transport exposure does not enable execution; handler returns `UNKNOWN` until coordinator composition exists. |

## Kubernetes best-practice findings

### Positive controls

The Deployment runs as non-root UID `10001`, sets `allowPrivilegeEscalation: false`, drops all Linux capabilities, uses a read-only root filesystem, and selects `RuntimeDefault` seccomp. Namespace labels request restricted Pod Security enforcement, audit, and warning modes. The server mTLS secret is mounted read-only, and the existing signer secret is also read-only. HTTP `8081` remains available for controlled rollback while gRPC `8443` is added as a distinct named port.

### Required mitigations before production

The deployment should use an immutable image digest rather than the literal `RELEASE_SHA` placeholder. Add image signature and provenance verification in admission or the deployment pipeline. Add a `PodDisruptionBudget` and topology spread constraints for the three replicas if availability requirements depend on maintaining quorum across nodes. Add explicit `startupProbe` or a gRPC health probe if the application exposes the standard gRPC health service; a TCP readiness probe proves only that a socket accepts connections, not that the typed service is ready.

The NetworkPolicy currently shown in the base manifest allows ingress to HTTP `8081` from monitoring and `umoja-control`, but it does not explicitly allow gRPC `8443` ingress from the authorized callers. If a default-deny policy is active, add exact ingress rules for the caller namespaces and service ports, or document that Istio interception occurs before the NetworkPolicy enforcement point in the chosen CNI. This must be tested, not assumed. OTel Collector egress should also be explicitly permitted if the CNI applies egress restrictions.

The `GRPC_SETTLEMENT_EXECUTION_ENABLED` environment variable is rendered as `false`, but the current startup function uses the presence of `GRPC_SETTLEMENT_LISTEN_ADDR` to start the listener and the fail-closed handler is hard-coded until coordinator composition. Keep the execution-disabled flag for operator clarity, but add a startup assertion that production cannot start an execution-enabled gRPC endpoint without the coordinator and all release controls.

## Istio best-practice findings

The corrected policy uses `PeerAuthentication` `STRICT` and an explicit `ALLOW` policy with exact principals. This matches the intended default-deny posture for the selected workload. The `DestinationRule` selects `ISTIO_MUTUAL`, uses HTTP/2 connection bounds, and configures outlier detection. The `ServiceEntry` declares the internal gRPC port using protocol `GRPC`.

Live validation must prove that the actual principals are the SPIFFE-like identities emitted by Istio for the caller workloads. Do not rely on the application metadata header used in local unit tests as a substitute for Envoy source identity. Run `istioctl authn tls-check`, `istioctl x authz check`, `istioctl proxy-config authz`, `istioctl proxy-config listeners`, and `istioctl proxy-config clusters` against the live pods. Confirm there is no permissive namespace or workload-level PeerAuthentication overriding the intended policy.

The policy’s `methods: ["POST"]` and port `8443` restrictions must be verified against the effective Envoy configuration and a real typed gRPC call. Test calls from an allowlisted control-plane pod, an allowlisted reconciliation pod, an unallowlisted pod, a wrong-namespace principal, and a plaintext client. Any unexpected acceptance is a critical failure.

## OTel security and compliance

The manifest points OTLP gRPC at `otel-collector.observability.svc.cluster.local:4317` and sets `service.namespace=umojaflowos` and `deployment.environment=staging`. The OTel Collector must enforce TLS or an approved in-cluster trust boundary, avoid raw payment payload attributes, and apply bounded tenant labels. Validate that traces and metrics contain only approved tenant-safe identifiers. Confirm that Collector queue overflow, refused spans, exporter failures, and resource exhaustion generate alerts without exposing sensitive fields.

## Evidence required for a GO decision

A GO decision requires the rendered manifest digest, successful server-side dry-run, admission results, immutable image digest/signature evidence, sidecar injection status, `STRICT` PeerAuthentication evidence, effective AuthorizationPolicy output, positive/negative gRPC calls, mTLS certificate subject/issuer/SAN evidence, plaintext denial, NetworkPolicy evidence, OTel trace and metric samples, resource profiles at 32/64/128/256 workers, rollback output, and four-role release approval. Static YAML review alone is insufficient.

## References

[1]: https://kubernetes.io/docs/concepts/security/pod-security-standards/ "Kubernetes Pod Security Standards"

[2]: https://kubernetes.io/docs/concepts/services-networking/network-policies/ "Kubernetes Network Policies"

[3]: https://istio.io/latest/docs/reference/config/security/peer_authentication/ "Istio PeerAuthentication Reference"

[4]: https://istio.io/latest/docs/reference/config/security/authorization-policy/ "Istio AuthorizationPolicy Reference"

[5]: https://istio.io/latest/docs/ops/diagnostic-tools/istioctl-analyze/ "Istio Configuration Analysis"
