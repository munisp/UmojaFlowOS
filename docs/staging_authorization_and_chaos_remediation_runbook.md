# Staging Authorization and Chaos Remediation Runbook

## Purpose

This runbook provisions the authorized staging prerequisites for E-04 through E-09 evidence collection and establishes controlled custody of the two execution approvals:

- `STAGING_EVIDENCE_APPROVED=CAPTURE_APPROVED_STAGING_EVIDENCE`
- `CHAOS_APPROVED=EXECUTE_APPROVED_STAGING_CHAOS`

These are **short-lived execution gates**, not permanent credentials. They must be injected by the release operator only after the named approver has reviewed the change record and staging boundary. They must never be committed to Git, printed in logs, stored in shell history, or reused for production.

## Non-negotiable boundaries

The environment must be isolated from production networks, production Kafka topics, production Temporal namespaces, customer funds, real customer identities, and production notification subscribers. Use pseudonymous test tenants and synthetic payment references. The test must be reversible and must leave no Toxiproxy toxic behind.

A missing observer, missing alert route, ambiguous ledger state, failed cleanup, or mixed-tenant notification is a **NO-GO** condition. Do not replace failed staging evidence with local fixtures.

## Roles and custody

| Role | Responsibility | Cannot do alone |
|---|---|---|
| Release Manager | Opens change record, pins release SHA, coordinates execution window, collects hashes. | Cannot self-approve security/compliance evidence. |
| Operations Owner | Provisions namespace, Toxiproxy, Prometheus, Alertmanager, and Novu bridge. | Cannot approve a failed recovery or ledger discrepancy. |
| Security Owner | Reviews network isolation, secrets, mTLS, redaction, and access logs. | Cannot approve a missing compliance disposition. |
| Compliance Owner/MLRO | Confirms alert workflow, tenant scope, escalation, and evidence sufficiency. | Cannot approve unverified technical recovery. |
| Independent Witness | Observes fault injection, alert receipt, cleanup, and recovery. | Must not be the executor or sole approver. |

At least two people must be present for chaos execution: the executor and the independent witness. The four release-manifest approval roles remain separate from this operational pair where practicable.

## Phase 1 — Provision isolated staging

1. Create a dedicated namespace or Compose project named `umoja-staging-observability` with a unique run identifier. Apply default-deny network policy, egress allowlists, non-root containers, read-only filesystems, and separate service accounts.
2. Provision a staging Kafka cluster with a dedicated test topic and retention appropriate for the run. Disable access to production brokers and use mTLS/SASL credentials scoped only to the test namespace.
3. Provision a staging Temporal server with a dedicated namespace, test task queue, and worker identity. Do not reuse production namespaces or task queues.
4. Deploy Toxiproxy in the isolated namespace. Create only the Kafka and Temporal proxies required for this run, with explicit upstream addresses and health checks.
5. Deploy the OpenTelemetry Collector, Prometheus, Alertmanager, Grafana Tempo, and the approved Alertmanager-to-Novou bridge. Use separate staging receivers and subscribers.
6. Configure service endpoints:

```bash
export TOXIPROXY_API=https://toxiproxy.staging.example.invalid
export KAFKA_PROXY_NAME=staging-kafka
export TEMPORAL_PROXY_NAME=staging-temporal
export PROMETHEUS_URL=https://prometheus.staging.example.invalid
export ALERTMANAGER_URL=https://alertmanager.staging.example.invalid
export NOVU_BRIDGE_URL=https://novu-bridge.staging.example.invalid
export OTEL_ENVIRONMENT=staging
```

Do not put real values in the repository or evidence documents. Inject them through the deployment secret store or a protected CI environment.

## Phase 2 — Verify preconditions

Run the existing deployment guide checks, then verify:

```bash
curl --fail "$TOXIPROXY_API/version"
curl --fail "$PROMETHEUS_URL/-/ready"
curl --fail "$ALERTMANAGER_URL/-/ready"
curl --fail "$NOVU_BRIDGE_URL/healthz"
curl --fail "$TOXIPROXY_API/proxies"
```

The proxy inventory must contain exactly the approved Kafka and Temporal proxy names and no production upstreams. Confirm Prometheus has the TigerBeetle, Collector, and compliance rule groups loaded:

```bash
curl --fail "$PROMETHEUS_URL/api/v1/rules?type=alert"
```

Confirm Alertmanager’s receiver is the staging Novu bridge and that its subscriber/workflow is a test destination. Send no real notification until the bridge contract test passes.

## Phase 3 — Obtain controlled approvals

The Release Manager attaches the following to the change record before requesting approvals:

- Release SHA and image digests.
- Namespace and network-isolation output.
- Kafka/Temporal proxy inventory and health output.
- Prometheus and Alertmanager readiness output.
- Novu bridge health and workflow identifier.
- Test tenant identifier and data-classification statement.
- Planned fault duration and rollback owner.
- Expected alert names and runbook links.
- Evidence destination and retention policy.

The Security Owner approves the staging boundary and secret handling. The Compliance Owner approves the test tenant, alert workflow, evidence redaction, and escalation path. The Operations Owner confirms rollback readiness. The Release Manager records each subject, role, timestamp, and release SHA in the change record.

Only after all required approvals are recorded may the executor export the short-lived gates in the same terminal session:

```bash
export STAGING_EVIDENCE_APPROVED=CAPTURE_APPROVED_STAGING_EVIDENCE
export CHAOS_APPROVED=EXECUTE_APPROVED_STAGING_CHAOS
```

The values must be cleared immediately after the run:

```bash
unset STAGING_EVIDENCE_APPROVED CHAOS_APPROVED
```

## Phase 4 — Capture baseline evidence

Before injecting faults, capture:

```bash
python3 scripts/infra/capture_otel_novu_audit_evidence.py \
  --execute \
  --release-sha "$RELEASE_SHA" \
  --out "$EVIDENCE_DIR/baseline.json"
```

Hash the output and record the run ID. Baseline acceptance requires all observers to be reachable and the dashboard to show healthy Collector, Prometheus, Alertmanager, and Novu bridge status.

## Phase 5 — Execute bounded chaos

Start the independent witness and execute:

```bash
python3 scripts/infra/chaos_partition_kafka_temporal.py \
  --execute \
  --toxiproxy "$TOXIPROXY_API" \
  --duration 45
```

The harness must:

- Verify both proxy names before fault injection.
- Apply only the approved downstream `down` toxics.
- Maintain the bounded duration.
- Query Prometheus for expected alert state.
- Preserve the original proxy configuration.
- Remove every toxic in a `finally` path.

Expected alerts include the Kafka/Temporal dependency failure, Collector/compliance telemetry warnings where applicable, and any settlement-fencing or UNKNOWN-state protection triggered by the test. Exact alert names must match the loaded rule files and the change record.

## Phase 6 — Verify routing and recovery

Capture Alertmanager’s active alerts and the Novu bridge’s request/acknowledgement record. Confirm:

1. The critical alert fired within the approved detection window.
2. Alertmanager grouped and routed the alert once per fingerprint.
3. The bridge transformed the payload without exposing sensitive labels.
4. The test tenant remained isolated.
5. The resolved notification arrived after toxic removal.
6. Kafka and Temporal recovered without duplicate work or unsafe retries.
7. Every Toxiproxy toxic was removed.
8. No ledger discrepancy, accidental settlement, or orphaned workflow remained.

Run the evidence capture harness again:

```bash
python3 scripts/infra/capture_otel_novu_audit_evidence.py \
  --execute \
  --release-sha "$RELEASE_SHA" \
  --out "$EVIDENCE_DIR/recovery.json"
```

## Hard-stop and rollback triggers

Immediately stop the exercise and keep settlement/compliance operations fenced if any of the following occurs:

| Trigger | Immediate action |
|---|---|
| Kafka or Temporal proxy points to production | Remove toxic, isolate namespace, revoke credentials, notify Security. |
| Prometheus or Alertmanager unavailable | Abort; no end-to-end evidence can be claimed. |
| Novu bridge returns an unexpected status or leaks sensitive data | Abort routing test; retain redacted response; open security incident. |
| Mixed tenant IDs occur in one notification | Abort; reject the batch; investigate isolation. |
| Toxics cannot be removed | Keep affected services fenced; manually restore only through approved operations procedure. |
| UNKNOWN or duplicate payment state appears | Do not retry or force settlement; invoke ledger reconciliation runbook. |
| RTO/RPO or recovery reconciliation fails | Keep NO-GO; open CAP and preserve all evidence. |

## Evidence package and closure

The final package must contain the approved change record, baseline and recovery JSON, Toxiproxy inventory, Prometheus query results, Alertmanager alerts, Novu bridge transformation/acknowledgement, trace IDs, cleanup output, dashboard screenshots, SHA-256 manifest, and independent witness statement.

The package is eligible for E-04/E-06/E-08 review only if all artifacts reference the same release SHA and run ID. E-09 additionally requires the four distinct release approvals and detached cryptographic signatures.

A successful run updates the CAP register with the evidence paths and reviewer. A blocked or failed run receives a time-bound disposition with owner, compensating control, expiry date, and mandatory retest. It does not become a pass.
