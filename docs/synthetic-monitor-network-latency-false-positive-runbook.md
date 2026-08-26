# Synthetic Monitor Network-Latency False-Positive Runbook

**Owner:** Platform Engineering and Retention Operations
**Applies to:** `UmojaRetentionSyntheticMonitorProbeFailed`, `UmojaRetentionSyntheticCircuitOpenObserved`, and `UmojaRetentionSynthetic503ErrorRateHigh` in production.
**Primary objective:** Determine whether an alert represents a retention-worker/database incident or an observation-path latency fault, while keeping the retention delete path fail-closed.

> A synthetic-monitor alert is **not** proof that the underlying worker circuit is open. It is an independent observation signal. Treat an unavailable or delayed monitor as an evidence gap, not as evidence that the worker is healthy.

## 1. Safety and classification rule

Do **not** silence the source worker alerts, disable the circuit breaker, widen network policy, relax mTLS, increase connection-pool limits, or retry deletion requests because the synthetic monitor is unavailable. These actions can convert an observation failure into a retention-integrity event.

Use the following classification only after collecting evidence from both the synthetic monitor and the worker/Prometheus paths.

| Classification | Minimum evidence | Initial disposition |
|---|---|---|
| Confirmed worker/database incident | Worker circuit state is open, worker 503-class outcomes are increasing, or PostgreSQL lock/pool alerts are firing | Keep PagerDuty incident active and use the connection-pool exhaustion runbook |
| Confirmed monitor-path latency fault | Worker health and circuit state remain stable; direct Prometheus worker scrape remains healthy; monitor probe fails or latency rises | Incident may be downgraded after evidence retention and platform-network ownership assignment |
| Monitoring blindness | Monitor and worker state cannot be independently observed or metrics are stale | Maintain incident severity; do not classify as false positive |
| Mixed incident | Monitor path is degraded and worker shows any concurrent degradation | Treat as a production retention incident until both paths recover |

## 2. First five minutes: contain and capture

Acknowledge the PagerDuty incident. Confirm the alert name, environment, alert fingerprint, start time, source Prometheus instance, and whether a permitted chaos or maintenance window is active. Do not declare a false positive solely because a planned maintenance event exists.

Capture the following before restarting or changing anything:

```promql
umoja_retention_synthetic_probe_success{environment="production"}
umoja_retention_synthetic_probe_latency_seconds{environment="production"}
umoja_retention_synthetic_probe_failures_total{environment="production"}
umoja_retention_synthetic_observed_circuit_state{environment="production"}
umoja_retention_worker_health{environment="production"}
umoja_retention_worker_db_circuit_state{environment="production"}
increase(umoja_retention_worker_results_total{environment="production",result=~"database_connection_pool_saturated|database_claim_error|database_circuit_open"}[5m])
pg_retention_lock_wait_max_wait_seconds{environment="production"}
```

Also capture the monitor and worker rollout state, Pod readiness, node placement, NetworkPolicy revision, service endpoints, and recent changes to service mesh, DNS, ingress/egress, certificates, or monitoring configuration.

```bash
kubectl -n security get pod -l app.kubernetes.io/name=umoja-retention-synthetic-monitor -o wide
kubectl -n security get pod -l app.kubernetes.io/name=umoja-retention-worker -o wide
kubectl -n security get endpoints umoja-retention-worker -o yaml
kubectl -n security get networkpolicy
kubectl -n security rollout history deployment/umoja-retention-synthetic-monitor
kubectl -n security rollout history deployment/umoja-retention-worker
```

## 3. Ten-minute diagnosis: separate observation from execution

First verify that Prometheus can scrape the worker directly. A healthy direct scrape while the synthetic monitor fails is evidence for a monitor-path issue, not final proof that the worker is healthy.

```promql
up{job=~".*retention.*worker.*",environment="production"}
max_over_time(umoja_retention_worker_db_circuit_state{environment="production"}[10m])
increase(umoja_retention_worker_db_circuit_open_total{environment="production"}[10m])
```

Next inspect the monitor endpoint, using a read-only request from an authorized operations environment:

```bash
kubectl -n security port-forward service/umoja-retention-synthetic-monitor 9468:9468
curl --fail http://127.0.0.1:9468/metrics | grep '^umoja_retention_synthetic_'
```

A latency-path false positive is supported only if all of the following are true:

1. Worker health remains `1`.
2. Worker circuit state remains `0`, with no new circuit-open transitions.
3. Worker 503-class results do not increase beyond the normal baseline.
4. PostgreSQL lock waits and pool waiters remain below their incident thresholds.
5. The synthetic monitor reports a failed probe or probe latency close to/above its timeout.
6. A controlled, read-only in-cluster request from the monitor network domain to the worker metrics endpoint demonstrates elevated latency, DNS failure, service-endpoint failure, or policy/mesh interference.

If any condition is missing, treat the alert as unresolved monitoring blindness or a mixed incident.

## 4. Network-latency investigation

Inspect these fault domains in order: monitor Pod resource pressure; DNS; service endpoints; NetworkPolicy; service mesh/sidecar policy; node-to-node routing; and recent deployment changes.

| Domain | Read-only evidence | Corrective action after approval |
|---|---|---|
| Monitor resource pressure | CPU/memory throttling, restarts, readiness, probe latency | Restore requested resources or roll back the monitor revision |
| DNS | CoreDNS errors, service-resolution failure from monitor Pod | Restore DNS health; do not replace worker endpoints manually |
| Service endpoints | Empty/stale endpoint list or no ready worker endpoints | Restore the worker Service/endpoint controller; verify worker readiness |
| NetworkPolicy | Recently changed policy denies monitor-to-worker TCP 8080 | Roll back only the reviewed policy revision; preserve default-deny posture |
| Service mesh | Sidecar mTLS, authorization, or retry-policy rejection | Restore approved mesh policy/certificates; do not bypass TLS |
| Node path | Both Pods concentrated on impaired node/zone | Use approved scheduling/remediation process and verify direct worker health |

For a controlled confirmation in staging, use the scoped `NetworkChaos` manifest. Never apply this Chaos Mesh fault in production merely to prove a suspected false positive:

```text
infra/retention-gateway/chaos-mesh/networkchaos-synthetic-monitor-worker-latency.yaml
```

## 5. Resolution and recovery

A confirmed monitor-path latency fault may be downgraded only after the monitor has recovered and the worker path has remained healthy for at least 15 minutes. Verify:

```promql
min_over_time(umoja_retention_synthetic_probe_success{environment="production"}[15m]) == 1
max_over_time(umoja_retention_synthetic_observed_circuit_state{environment="production"}[15m]) == 0
increase(umoja_retention_worker_db_circuit_open_total{environment="production"}[15m]) == 0
sum(increase(umoja_retention_worker_results_total{environment="production",result=~"database_connection_pool_saturated|database_claim_error|database_circuit_open"}[15m])) == 0
```

If any retention authorization was attempted during a confirmed worker incident, reconcile the affected decision digests, manifest signatures, and exact index identities before closure. A synthetic-only network latency event that never reached the worker deletion path does not itself require authorization replay.

The incident commander, retention owner, and platform/network owner must record the final classification, corrective change, verification window, Prometheus evidence links, Kubernetes revisions, and PagerDuty timeline. Update the relevant NetworkPolicy, mesh, DNS, or capacity change record and create a follow-up item if monitor-path redundancy or alert grouping needs improvement.

## 6. Prohibited actions

The following are prohibited during triage:

- Disabling or loosening the retention worker circuit breaker.
- Silencing real worker or PostgreSQL alerts because the synthetic alert was a false positive.
- Changing deletion authorization state, legal holds, WORM evidence, or OpenSearch roles.
- Broadening NetworkPolicy to allow all traffic.
- Disabling mTLS or certificate verification.
- Restarting database pods or terminating PostgreSQL backends without the database incident authority.
- Replaying unknown deletion requests without reconciliation.

## 7. Evidence and closure checklist

| Item | Required before closure |
|---|---|
| Alert classification | Confirmed worker incident, confirmed monitor-path latency, monitoring blindness, or mixed incident |
| Probe evidence | Synthetic state, latency, failures, and recovery window saved |
| Worker evidence | Health, circuit state, 503-class outcomes, and direct scrape state saved |
| Database evidence | Lock/pool metrics and any read-only diagnostic outputs saved |
| Network evidence | Endpoint, policy, mesh/DNS, node, and deployment observations saved |
| Corrective action | Change ID, approver, rollback plan, and outcome saved |
| Independent review | Retention and platform/network owners approve closure |

## References

[1]: https://prometheus.io/docs/practices/instrumentation/ "Prometheus Documentation — Instrumentation"
[2]: https://kubernetes.io/docs/concepts/services-networking/network-policies/ "Kubernetes Documentation — Network Policies"
[3]: https://chaos-mesh.org/docs/ "Chaos Mesh Documentation"
