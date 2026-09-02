# Native Idem Cross-Region Partition and DR Runbook

## Safety boundary

Run only against an approved disposable or staging environment. Never inject partitions into production. The procedure must be authorized with `TIGERBEETLE_CHAOS_APPROVED=STAGING_ONLY_APPROVED` and must verify the target host, private CIDR, duration, and release evidence before changing network state.

A simulated test is not regulatory live evidence. Store test output separately and mark it `simulation: true`.

## 1. Preflight

```bash
set -Eeuo pipefail
export UMOJA_TEST_DATABASE_URL='postgres://umoja_app:<password>@127.0.0.1:5432/umoja_test?sslmode=verify-full'
export KAFKA_BROKERS='region-a-kafka:9093,region-b-kafka:9093'
export RECONCILIATION_RUN_ID="staging-partition-$(date -u +%Y%m%dT%H%M%SZ)"
export TIGERBEETLE_CHAOS_APPROVED=STAGING_ONLY_APPROVED
export TIGERBEETLE_CHAOS_PRODUCTION=false

# Verify no production markers are present.
test "${UMOJA_ENV:-staging}" != production
printf 'run_id=%s\n' "$RECONCILIATION_RUN_ID"
```

The test must begin with a healthy ledger and router state:

```text
quorum_healthy = 1
node_view_divergent = 0
settlement_fence_active = 1
replication_lag_seconds < approved SLO
Kafka consumer lag < approved threshold
PostgreSQL primary and standby are reachable
```

Capture the baseline metrics and database state before injecting the fault:

```bash
curl --fail --silent http://payment-engine:8081/metrics > evidence/baseline-payment-engine.prom
psql "$UMOJA_TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "SELECT now(), current_setting('server_version'), pg_is_in_recovery();" \
  > evidence/baseline-postgres.txt
```

## 2. Simulate a cross-region network partition

For a host-level TigerBeetle staging partition, use the existing guarded runner:

```bash
export TIGERBEETLE_CHAOS_CONFIRM_HOST=<exact-approved-staging-replica-hostname>
export TIGERBEETLE_CHAOS_TARGETS='<peer-ip-1>:3000,<peer-ip-2>:3000'
export TIGERBEETLE_CHAOS_ALLOWED_CIDRS='<approved-private-cidr-1>,<approved-private-cidr-2>'
export TIGERBEETLE_CHAOS_DURATION_SECONDS=30
sudo -E scripts/infra/tigerbeetle_partition_chaos.sh \
  | tee "evidence/tigerbeetle-partition-${RECONCILIATION_RUN_ID}.log"
```

The runner validates the approval marker, exact hostname, non-production mode, root privileges, target syntax, private CIDRs, and a maximum duration of 300 seconds. It removes its firewall rules through an exit trap.

For application-level cross-region network faults, prefer a Toxiproxy or Chaos Mesh proxy in front of the Kafka and PostgreSQL endpoints. The fault must be applied to a disposable proxy, not to an uncontrolled production route:

```bash
# Example Toxiproxy setup inside an isolated staging network.
toxiproxy-cli create region-b-kafka \
  -l 0.0.0.0:19093 -u region-b-kafka:9093
toxiproxy-cli create region-b-postgres \
  -l 0.0.0.0:15432 -u region-b-postgres:5432

toxiproxy-cli toxic add region-b-kafka \
  -t timeout -a timeout=10000 -a точ=upstream
# Or, where supported by the installed CLI, cut the proxy connection:
toxiproxy-cli toggle region-b-kafka
```

If the local Toxiproxy version does not support the exact command, do not improvise against a real endpoint. Use the repository’s pinned proxy/Chaos Mesh configuration and record the version in the evidence bundle.

## 3. Assertions for the Go settlement router

Submit a test-only request with a unique idempotency key and the active reconciliation run ID. The expected result is not a successful settlement:

```bash
curl --fail-with-body --silent --show-error \
  -X POST http://payment-engine:8081/test/settlement \
  -H 'Content-Type: application/json' \
  -H "X-Reconciliation-Run-ID: $RECONCILIATION_RUN_ID" \
  -d '{"tenant_id":"chaos-tenant","idempotency_key":"partition-test-001","asset":"USDC","amount_minor":100}' \
  | tee evidence/router-response.json || true
```

Verify all of the following:

```text
response state = UNKNOWN or FENCED
settlement_allowed = false
TigerBeetle post count did not increase
secondary provider submit count did not increase
PostgreSQL durable UNKNOWN row exists
payload SHA-256 is unchanged
reconciliation_run_id matches the signed test manifest
settlement fence metric = 1
```

Example database assertions:

```sql
SELECT tenant_id, idempotency_key, status, release_sha,
       reconciliation_run_id, tigerbeetle_transfer_id
FROM stablecoin_intent
WHERE tenant_id = 'chaos-tenant'
  AND idempotency_key = 'partition-test-001';

SELECT decision, settlement_allowed, reconciliation_run_id
FROM provider_reconciliation_decision
WHERE idempotency_key = 'partition-test-001'
ORDER BY decided_at DESC;
```

The test fails if a router returns `SETTLED`, submits to a fallback rail, creates a second transfer ID, or commits a Kafka offset before the UNKNOWN decision is durable.

## 4. Recovery from TigerBeetle quorum loss

### Detect and fence

1. Page the incident commander and ledger owner.
2. Confirm `umoja_tigerbeetle_cluster_quorum_healthy == 0` or node-view divergence.
3. Set the settlement fence to active using the approved control-plane command.
4. Stop payment-engine settlement consumers and provider submissions. Keep read-only reconciliation available.
5. Do not restart all replicas simultaneously and do not delete data files.
6. Capture node identity, cluster ID, addresses, logs, metrics, and exact failure time.

### Establish a trusted view

A recovery operator must identify the surviving quorum or declare that no trusted quorum exists. Do not choose a node based only on recency. Compare cluster identity, replica membership, commit/index state, and immutable deployment evidence.

If quorum is unavailable, the correct state is:

```text
writes blocked
UNKNOWN operations retained
read-only reconciliation allowed
no failover submission
no manual balance correction
```

### Restore and reconcile

1. Remove the network fault only after the partition window is documented.
2. Verify all replicas report the same cluster identity and converged view.
3. Verify quorum health and zero node-view divergence for the approved observation window.
4. Run read-only TigerBeetle-to-PostgreSQL reconciliation.
5. Compare every affected transfer by deterministic transfer ID, idempotency key, payload digest, and audit run ID.
6. Resolve only confirmed outcomes. Keep ambiguous operations UNKNOWN.
7. Capture the recovery report and independent review.

### Resume gate

Settlement may resume only when all conditions are true:

```text
quorum healthy = true
node view divergent = 0
recovery view converged = 1
PostgreSQL/TigerBeetle unexplained mismatch count = 0
Kafka lag below approved threshold
all affected UNKNOWN states dispositioned or safely retained
mTLS and release manifest gates pass
four-role recovery approval is present
```

If any condition is false or telemetry is absent, keep the fence active.

## 5. PostgreSQL replication divergence recovery

### Detect

Capture `pg_stat_replication`, WAL/LSN positions, recovery state, replication slots, lock state, and application connection routing. Never promote a standby based on application symptoms alone.

```sql
SELECT application_name, client_addr, state, sync_state,
       sent_lsn, write_lsn, flush_lsn, replay_lsn,
       pg_wal_lsn_diff(sent_lsn, replay_lsn) AS bytes_lag
FROM pg_stat_replication;

SELECT pg_is_in_recovery();
```

### Fence and preserve

1. Stop writes to all suspected primaries and standbys.
2. Keep the application role unable to perform DDL or direct audit mutation.
3. Preserve WAL, PostgreSQL logs, replication metadata, and connection-router logs.
4. Record each node’s system identifier, timeline, LSN, and run ID.
5. Do not use `pg_resetwal`, remove replication slots, or force-promote a node without an approved database recovery decision.

### Rebuild or promote

A database specialist must select the authoritative timeline using the approved recovery policy. If no trusted primary can be established, restore a verified backup to an isolated node and reconcile it read-only before reopening writes.

After promotion or rebuild:

```text
verify system identifier and timeline
verify schema migration level
verify RLS is enabled and forced
verify umoja_app is not a superuser
verify stablecoin intent and terminal-decision uniqueness
verify audit run-ID bindings
verify TigerBeetle projection parity
```

## 6. Evidence and post-exercise outputs

The evidence bundle should contain:

```text
runbook version
simulation=true
authorization record
baseline metrics
partition command and proxy version
router response
TigerBeetle logs and quorum metrics
PostgreSQL replication and lock snapshots
Kafka lag snapshots
OTel trace IDs and run-ID correlation
reconciliation output
recovery timestamps
independent reviewer decision
corrective-action plan
```

A simulation must not be copied into the production GO-gate directory as live evidence. Mark any local or simulated artifact with an explicit provenance field and keep it separate from authorized E-01–E-09 evidence.
