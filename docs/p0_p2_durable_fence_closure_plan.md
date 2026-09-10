# P0–P2 Durable Settlement Fence Closure Plan

## Scope

This change closes the P0 global-fence consistency gap and hardens selected P1/P2 release-gate controls. The settlement fence now has a durable per-environment state in PostgreSQL, and every guarded ledger post refreshes that state before invoking the authoritative ledger client.

## Code changes

| Area | Change | Safety property |
|---|---|---|
| PostgreSQL | Added `0060_durable_settlement_fence_state.sql` | Shared fence state survives process restart and is visible to every replica |
| Command store | Added per-environment advisory transaction lock | Commands for one environment apply serially; unrelated environments can progress concurrently |
| Command replay | Existing `command_id` primary key plus canonical SHA-256 hash comparison | Same-ID/same-payload is idempotent; same-ID/different-payload is a hard replay conflict |
| Sequence allocation | Uses `nextval('settlement_fence_command_version_seq')` | No `MAX()+1` race under concurrent replicas; gaps are allowed and documented |
| Ledger guard | Added `CheckContext` durable-state refresh | Database outage, missing state, or fenced state blocks the ledger call |
| Startup | Added strict `UMOJA_FENCE_DATABASE_URL` and `UMOJA_FENCE_PUBLIC_KEY_B64` validation | Production cannot start an enabled ledger without durable fence dependencies |
| GO gate | Added standalone schema and Ed25519 verification and exact E-01–E-09 set checks | Filename-only sidecar validation cannot produce a false pass |
| Evidence schema | Requires exactly nine evidence IDs and exactly four roles | Missing and duplicate evidence/roles are rejected at schema level |

## Production environment contract

```text
UMOJA_ENV=production
UMOJA_FENCE_DATABASE_URL=postgres://...
UMOJA_FENCE_PUBLIC_KEY_B64=<32-byte Ed25519 public key in Base64>
UMOJA_FENCE_DB_MAX_OPEN_CONNS=16
UMOJA_FENCE_DB_MAX_IDLE_CONNS=8
UMOJA_FENCE_DB_CONN_MAX_LIFETIME=30m
```

The database must have migrations `0059_settlement_fence_commands.sql` and `0060_durable_settlement_fence_state.sql` applied by the schema-owner process before the payment engine starts. The application role receives `SELECT`, `INSERT`, and `UPDATE` only for the required fence tables, plus sequence usage; it does not receive DDL or delete privileges.

## Ephemeral integration run

The repository runner is:

```bash
scripts/infra/run_fence_postgres_testcontainers.sh
```

It uses Docker or Podman to create an ephemeral PostgreSQL 16 container, applies both migrations, exports `UMOJA_FENCE_TEST_DATABASE_URL`, runs race-enabled tests, and executes the PostgreSQL contention benchmark.

```bash
cd /home/ubuntu/UmojaFlowOS-repo
CONTAINER_RUNTIME=docker \
FENCE_BENCH_TIME=30s \
FENCE_BENCH_COUNT=3 \
./scripts/infra/run_fence_postgres_testcontainers.sh
```

The partition rehearsal is:

```bash
./scripts/infra/run_settlement_fence_partition_rehearsal.sh
```

It pauses the ephemeral database, verifies that new durable writes fail, unpauses it, and reruns recovery tests. This validates authority loss and fail-closed behavior. It is not by itself a proof of PostgreSQL HA split-brain safety; the latter requires a real multi-node HA topology, promotion controls, timeline/LSN evidence, and writer fencing.

## Verification commands

```bash
cd /home/ubuntu/UmojaFlowOS-repo
python3 -m py_compile scripts/infra/validate_production_go_gate.py
python3 -m json.tool assurance/release_evidence_manifest.schema.json >/dev/null
bash -n scripts/infra/run_fence_postgres_testcontainers.sh
bash -n scripts/infra/run_settlement_fence_partition_rehearsal.sh

auto_go_toolchain="$PWD/services/payment-engine/.toolchain/go/bin:$PWD/.toolchain/go/bin"
export PATH="$auto_go_toolchain:$PATH"
cd services/payment-engine
gofmt -w cmd/payment-engine/fence_startup.go cmd/payment-engine/main.go \
  internal/reconciliation/fence.go internal/reconciliation/durable_fence_test.go \
  internal/fencestore/postgres.go

go test ./cmd/payment-engine ./internal/reconciliation ./internal/fencestore \
  ./internal/observability -count=1 -race
```

## Remaining external evidence required for GO

Code-level closure does not replace the following required evidence:

1. Multi-node PostgreSQL failover and actual split-brain rehearsal with authoritative writer fencing.
2. At least two payment-engine replicas proving a shared fence transition blocks both replicas.
3. Live approved provider, custody, banking, and blockchain-finality execution evidence.
4. Successful GitHub Actions runs for the current commit, including secret scanning, OPA/Conftest, Helm, Kind, and release evidence jobs.
5. Real E-01–E-09 artifacts, WORM retention proof, and four independent approval sidecars.
6. Independent operational witness sign-off for opening the settlement fence after recovery.
