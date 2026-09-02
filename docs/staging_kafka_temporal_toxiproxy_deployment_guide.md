# Staging Kafka and Temporal Toxiproxy Deployment Guide

## Purpose and boundary

This guide provisions a controlled staging path for simulating Kafka and Temporal network partitions. It is designed for the UmojaFlowOS observability and regulatory evidence workflow. It must not be used against production endpoints, customer traffic, or a ledger cluster handling live funds.

The target topology is:

```text
Kafka clients ──► kafka proxy ──► staging Kafka broker
Temporal workers/clients ──► temporal proxy ──► staging Temporal frontend
                                      │
                                      ▼
                              Toxiproxy API
                                      │
                                      ▼
                              Prometheus/Alertmanager
```

The chaos harness only changes Toxiproxy toxics. It does not modify Kafka offsets, Temporal workflow state, TigerBeetle data, PostgreSQL rows, or payment decisions.

## Prerequisites

The operator must have an approved staging change record, an explicit test window, an incident commander, a compliance observer, and a rollback owner. The staging network must be isolated from production. Required tools are Docker Compose or Kubernetes, Toxiproxy, Prometheus, Alertmanager, and the repository’s `promtool` binary.

Set endpoints through a protected environment file or secret manager. Do not commit credentials, provider tokens, mTLS private keys, or Novu API keys.

```bash
export KAFKA_UPSTREAM=staging-kafka:9092
export TEMPORAL_UPSTREAM=staging-temporal:7233
export TOXIPROXY_API=http://toxiproxy:8474
export PROMETHEUS_URL=http://prometheus:9090
```

## Provision Toxiproxy with Docker Compose

Add a Toxiproxy service to the staging-only Compose profile:

```yaml
services:
  toxiproxy:
    image: shopify/toxiproxy:2.9.0
    command: ["-host=0.0.0.0"]
    ports:
      - "8474:8474"
      - "19092:19092"
      - "17233:17233"
    networks: [protected]
```

The Kafka client endpoint must be configured as `toxiproxy:19092`; the Temporal client/worker endpoint must be configured as `toxiproxy:17233`. Never configure these proxy listeners with production broker or frontend addresses.

Create the proxies through the local API:

```bash
curl -fsS -X POST "$TOXIPROXY_API/proxies" \
  -H 'Content-Type: application/json' \
  -d '{"name":"kafka","listen":"0.0.0.0:19092","upstream":"staging-kafka:9092","enabled":true}'

curl -fsS -X POST "$TOXIPROXY_API/proxies" \
  -H 'Content-Type: application/json' \
  -d '{"name":"temporal","listen":"0.0.0.0:17233","upstream":"staging-temporal:7233","enabled":true}'
```

If the proxy already exists, inspect it instead of creating a duplicate:

```bash
curl -fsS "$TOXIPROXY_API/proxies/kafka"
curl -fsS "$TOXIPROXY_API/proxies/temporal"
```

## Provision through Kubernetes

Create a staging-only Toxiproxy Deployment and Service, expose ports 8474, 19092, and 17233 internally, and apply a NetworkPolicy that allows access only from the staging payment-engine, Temporal worker, Kafka client, Prometheus, and chaos-runner service accounts. The Toxiproxy API must not be exposed through an internet-facing Ingress.

The proxy configuration must be stored in a staging ConfigMap or applied idempotently by the provisioning Job. The upstream broker and Temporal addresses must be injected from non-production configuration, not hard-coded production endpoints.

Validate the service account, namespace, NetworkPolicy, and listener endpoints before creating any toxic:

```bash
kubectl -n umoja-staging get deploy,svc,networkpolicy -l app=toxiproxy
kubectl -n umoja-staging port-forward svc/toxiproxy 8474:8474
curl -fsS http://127.0.0.1:8474/proxies
```

## Preflight checklist

The test may proceed only when all of the following are true:

| Check | Acceptance criterion |
|---|---|
| Environment | Namespace/project is explicitly staging and isolated from production. |
| Approval | Change record and `EXECUTE_APPROVED_STAGING_CHAOS` authorization are present. |
| Proxies | `kafka` and `temporal` exist, are enabled, and point only to staging upstreams. |
| Traffic | No live customer funds or unrestricted production traffic traverses the proxies. |
| Settlement | Payment settlement fence and UNKNOWN-state handling are enabled. |
| Observability | Prometheus, Alertmanager, Collector, and the runbook are reachable. |
| Recovery | Operators can remove toxics and restore normal proxy routing. |
| Evidence | Run ID, release SHA, proxy inventory, alert snapshots, and cleanup output have an immutable destination. |

## Execute the controlled partition

Use the repository harness from the checked-out release SHA:

```bash
export CHAOS_APPROVED=EXECUTE_APPROVED_STAGING_CHAOS
export KAFKA_PROXY_NAME=kafka
export TEMPORAL_PROXY_NAME=temporal
export TOXIPROXY_API=http://127.0.0.1:8474
export PROMETHEUS_URL=http://127.0.0.1:9090

python3 scripts/infra/chaos_partition_kafka_temporal.py \
  --execute \
  --duration 45
```

The harness validates both proxies before fault injection, adds downstream `down` toxics, waits for the bounded duration, queries Prometheus for alert state, and removes every toxic in a `finally` cleanup path. A missing proxy, non-local endpoint, absent authorization token, or observer failure is a failed test—not a pass.

## Expected alert behavior

The partition should cause Kafka and Temporal client failures or latency, downstream health degradation, and the relevant Collector/availability alerts. Compliance and ledger-integrity alerts must remain fail-closed. The system must not silently acknowledge payment work, retry a potentially committed transaction on another rail, or mutate ledger state during the partition.

Alertmanager must group the incident by alert name, service, environment, and compliance impact. Critical compliance alerts must route to the approved Novu bridge and the local audit sink. Resolved notifications must be delivered after toxic removal and service recovery.

## Rollback and emergency termination

Terminate immediately if customer traffic enters the test path, a payment is submitted to an unintended provider, the settlement fence is inactive, a ledger mismatch appears, the Prometheus observer is unavailable, or the Toxiproxy API is no longer controllable.

Remove toxics manually if the harness exits abnormally:

```bash
curl -fsS -X DELETE "$TOXIPROXY_API/proxies/kafka/toxics/umoja-kafka-partition"
curl -fsS -X DELETE "$TOXIPROXY_API/proxies/temporal/toxics/umoja-temporal-partition"
```

Confirm that both proxies are enabled and have no test toxic:

```bash
curl -fsS "$TOXIPROXY_API/proxies/kafka"
curl -fsS "$TOXIPROXY_API/proxies/temporal"
```

If any transfer is UNKNOWN, hold it for authoritative reconciliation. Do not manually mark it successful, do not edit audit rows, and do not retry blindly.

## Evidence package

Retain the following artifacts under an immutable run ID:

1. Release SHA and repository status.
2. Approval/change-record identifier.
3. Redacted proxy inventory before and after the test.
4. Harness stdout/stderr and exit code.
5. Prometheus alert query responses before, during, and after the partition.
6. Alertmanager notification and resolution payloads.
7. Novu bridge transformation and delivery acknowledgement.
8. Payment-engine settlement-fence and UNKNOWN-state metrics.
9. Cleanup confirmation and post-test health checks.
10. Observer, incident commander, compliance observer, and rollback owner attestations.

Hash each artifact and bind the collection to the release evidence manifest. The run is not regulatory evidence until the authorized reviewer verifies the chain of custody and signs the same release SHA.

## Go/no-go criteria

The test is a **PASS** only if the partition is limited to staging, critical alerts fire within the defined alert windows, notifications reach Alertmanager and the approved Novu bridge, settlement remains fenced, UNKNOWN transactions remain held, toxics are removed, normal health returns, and all evidence is complete.

Any missing notification, unverified cleanup, unexpected settlement, telemetry gap, unexplained reconciliation difference, or unapproved endpoint produces **NO-GO** and opens a corrective-action plan.
