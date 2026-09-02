# Settlement Fence PostgreSQL Split-Brain and Failover Recovery Playbook

## Objective

Recover safely when the Alertmanager fence bridge, payment-engine replicas, PostgreSQL primary, or PostgreSQL replication topology experiences a partition or failover during active settlement fencing. The recovery objective is to preserve the invariant that no ambiguous command or ledger outcome creates a duplicate transfer.

> When command history, fence state, database leadership, or ledger finality is ambiguous, keep settlement fenced and classify affected intents as `UNKNOWN` until evidence converges.

## Trigger conditions

Start this playbook for any of the following:

| Trigger | Immediate posture |
|---|---|
| PostgreSQL primary/standby split-brain suspicion | Fence settlement; stop writes to both suspected sides |
| Database failover during a fence command | Fence remains active; freeze command application until one writer is authoritative |
| Different replicas report different fence versions | Fence settlement and enter evidence reconciliation |
| Alertmanager bridge retry storm or duplicate command delivery | Retain fence; inspect command IDs and hashes |
| OPA retry exhaustion while database health is uncertain | Persist `UNKNOWN` only where durable storage is confirmed; otherwise retain Kafka records for redelivery |
| Payment engine cannot read durable fence state | Treat fence state as active |

## Roles and dual control

The incident commander controls the operational sequence. The database lead establishes PostgreSQL authority. The payment-engine lead verifies ledger posting is fenced. The compliance lead authorizes evidence closure. No single operator may both declare a new database primary and reopen settlement.

## Phase 0 — Immediate containment

1. Declare a critical incident and record UTC time, incident ID, environment, and current release SHA.
2. Do not issue an `OPEN` command. If an `OPEN` command is in flight, reject it unless it is independently authorized and the command is still inside its validity window.
3. Activate the payment-engine circuit breaker on every reachable replica. If a replica cannot be reached, treat it as fenced by default and isolate it from ledger connectivity.
4. Block new authoritative ledger posts at the network or service-mesh layer where possible.
5. Pause automated reconciliation workers that could perform settlement decisions against an uncertain database writer.
6. Preserve Kafka offsets, PostgreSQL WAL/LSN positions, payment-engine logs, Alertmanager payloads, and OTel trace IDs.

## Phase 1 — Establish database authority

1. Identify the last known PostgreSQL primary and all candidate standbys.
2. Compare timeline IDs, current LSN, replay LSN, synchronous-standby status, and fencing/lease metadata.
3. Confirm that no two nodes accept writes. If two nodes accepted writes, classify the database as split-brain and do not merge by application-level guessing.
4. Use the approved PostgreSQL fencing mechanism, such as a consensus-backed lease, STONITH, or infrastructure-level instance isolation, to isolate the stale writer.
5. Promote exactly one survivor using the approved database procedure.
6. Record the selected primary timeline, promotion LSN, and operator approvals in the incident evidence bundle.
7. Reconfigure the payment engine to use only the selected primary or a verified writer endpoint.
8. Verify that the application role has no DDL privileges and can access only the required command table operations.

## Phase 2 — Reconcile fence commands

On the authoritative primary, inspect the command ledger:

```sql
SELECT command_id, command_hash, action, environment,
       issued_at, expires_at, applied_at, fence_version, audit_hash
  FROM settlement_fence_commands
 WHERE environment = :'environment'
 ORDER BY fence_version, applied_at, command_id;
```

Check for duplicate IDs, hash conflicts, gaps in versions, commands applied after expiration, and commands present in Alertmanager delivery logs but absent from PostgreSQL.

A same-ID/same-hash duplicate is an idempotent delivery. A same-ID/different-hash event is a replay conflict and requires security investigation. Never choose one payload arbitrarily.

## Phase 3 — Reconcile payment intents and ledger transfers

1. Keep the global settlement fence active.
2. Identify every intent whose OPA evaluation, fence command, database commit, or TigerBeetle post overlapped the incident window.
3. Query TigerBeetle by deterministic transfer ID; do not submit a new transfer merely because the first response was lost.
4. Compare TigerBeetle transfer state, PostgreSQL intent state, provider status, Kafka event ID, and audit evidence.
5. Map any incomplete or conflicting evidence to durable `UNKNOWN`.
6. Resolve an `UNKNOWN` intent only after the authoritative ledger and provider evidence agree and the reconciliation decision is recorded transactionally.
7. Record a unique evidence digest for each decision. Conflicting evidence digests must remain blocked and generate a compliance incident.

## Phase 4 — Verify OPA and bridge health

Before any reopening decision, verify:

```text
OPA readiness with policy bundle loaded
OPA evaluation errors = zero during canary window
OPA retry exhaustion = zero during canary window
Alertmanager route matches only approved critical OPA alerts
Fence bridge signature verification succeeds
Audit store accepts exactly one record per command_id
Payment-engine replicas agree on fence version and state
```

Run a signed staging or isolated canary `FENCE` command. Verify invalid signatures, expired commands, future-issued commands, replayed commands, and same-ID/different-payload commands are rejected.

## Phase 5 — Controlled reopening

Settlement may be reopened only after:

1. PostgreSQL authority is singular and stable.
2. Replication and WAL evidence meet the approved SLO.
3. TigerBeetle quorum and view convergence are healthy.
4. No unresolved replay conflicts or ambiguous transfers remain unowned.
5. OPA readiness and policy evaluation are healthy.
6. Alertmanager and bridge telemetry are present.
7. Two authorized roles approve the recovery record.
8. A separately authorized `OPEN` command is signed, within its validity window, and accepted by every payment-engine replica.
9. The first post-recovery settlement is a controlled canary with deterministic verification.

Do not reopen because an alert resolved. Do not reopen because a new database primary is reachable. Reopening requires the complete evidence set.

## Failure branches

| Failure | Action |
|---|---|
| No authoritative PostgreSQL primary | Keep fenced; isolate writers; restore quorum or perform approved recovery |
| Both database sides accepted writes | Keep fenced; preserve both WAL histories; conduct forensic reconciliation |
| Command hash conflict | Reject command; keep current fence; escalate to security/compliance |
| Missing command audit record | Treat command as unapplied and unsafe; keep fenced until evidence is restored |
| Payment-engine replica cannot read fence state | That replica remains fenced and must be removed from service |
| TigerBeetle status is ambiguous | Never retry by creating a new transfer; use deterministic status lookup/reconciliation |
| OPA remains unavailable | Keep per-intent and global settlement controls fail-closed |
| Audit store unavailable | Do not apply new fence transitions or reopen settlement |

## Evidence and closure

The incident bundle must contain the incident timeline, PostgreSQL timeline/LSN evidence, primary-selection approvals, fence command rows, canonical command hashes, Alertmanager deliveries, bridge logs, payment-engine fence state from every replica, Kafka offsets, OPA metrics, TigerBeetle transfer queries, UNKNOWN reconciliation decisions, and final recovery approvals.

Closure requires a post-incident review confirming that only one PostgreSQL writer existed, no duplicate transfer was created, all replay conflicts were investigated, no unsigned command was accepted, and all evidence was retained under the applicable WORM policy.
