# In-Memory Map Audit — 2026-10-04

Branch: `audit-remittance-bdc-antiwipe-performance-2026-09-24`

## Scope

Full-repo sweep for in-memory `Map`/`HashMap`/dict-backed state across TypeScript/JavaScript, Go, Rust, and Python (996 files indexed; `node_modules`, build artifacts, and runtime dirs excluded). Every occurrence classified as:

| Class | Meaning | Action |
|---|---|---|
| CRITICAL | Business-data store lost on restart | Must gain durable backing |
| MEDIUM | Session/auth state | Durable or Redis-backed acceptable |
| Benign | Per-request derivation, bounded cache | No action |
| Test-only | Dev/test harness | No action |

## Sweep results

154 keyword hits: TS 8, Go 72, Rust 3, Python 71. After manual classification the vast majority are test fixtures, per-request derivations, or already durable-backed.

## Findings and disposition

| # | Site | Lang | Class | Disposition |
|---|---|---|---|---|
| 1 | `apps/control-plane/server/multiRailFailover.ts` — `MultiRailCoordinator.records` | TS | CRITICAL | FIXED — migration `0067_multirail_submission_records.sql`; `PostgresSubmissionRecordStore` (INSERT … ON CONFLICT DO NOTHING RETURNING, authoritative SELECT on race); in-memory store retained for tests/dev only |
| 2 | `services/ledger-gateway/src/multirail_failover.rs` — `Coordinator.records` | Rust | CRITICAL | FIXED — `RecordStore` trait + `WalRecordStore` append-only fsync'd JSONL journal (write-before-cache, first-writer-wins on replay); in-memory store retained for tests/local only |
| 3 | `services/payment-engine/internal/reconciliation/fence.go` — `SettlementFence.seen` | Go | Benign (durable-backed) | No fix — replay determinism already guaranteed by Postgres `settlement_fence_commands` (ON CONFLICT) + advisory lock in `fencestore/postgres.go` |
| 4 | `services/payment-engine/internal/provider/yellowcard_webhook.go` — `InMemoryReplayStore` | Go | Test/dev-only | No fix — production path uses TLS `RedisReplayStore` |
| 5 | `operatorDirectory.ts` and per-request derivations | TS | Benign | No fix — rebuilt per request, not authoritative state |
| 6 | Remaining 148 hits | all | Test-only / caches | No fix |

## Fix evidence

- TypeScript: 3/3 PGlite adversarial tests (`multiRailFailoverPostgres.test.ts`, gated by `PGLITE_MULTIRAIL_TEST=1`, applies the real 0067 DDL from disk): restart-simulation replay returns stored record with `calls === 1`; insert-race loser receives winner's record; schema rejects bogus `status`. Plus 4/4 pre-existing coordinator tests — all green under vitest.
- Rust: `cargo test` full `ledger-gateway` suite — 18/18 pass, including `wal_store_replays_after_reopen_without_resubmit` (no resubmission after restart) and `wal_store_first_writer_wins` (journal replay keeps first writer).

## Persistence targets

| Store | Target |
|---|---|
| Multirail submission idempotency (TS) | Postgres table `multirail_submission_records` (0067) |
| Multirail submission idempotency (Rust) | fsync'd WAL journal (local dev/edge); Postgres store trait-compatible for cluster deployment |
| Webhook replay (Go) | Redis (TLS) — already implemented |

## Honest limits

- The TS Postgres store is wired via `createPostgresSubmissionRecordStore()` with a dynamic import of the pool; deployments must opt in — the default constructor remains in-memory for backward compatibility and is now explicitly documented TESTS/DEV ONLY.
- `package.json` was deliberately not modified (frozen-lockfile CI); the PGlite test self-skips without the dep and env flag.
