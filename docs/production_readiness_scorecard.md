# UmojaFlowOS Production-Readiness Scorecard

## Executive decision

The current evidence supports a **conditional Technical GO for tested local and database-backed paths**, but not a universal production GO or regulatory activation GO. The strongest new result is the coverage-enabled PostgreSQL multirail run: with the `integration` build tag and the provisioned `umoja_test` database, the durable UNKNOWN-state store’s principal SQL paths were exercised under real PostgreSQL transactions.

> Coverage thresholds in this scorecard are proposed engineering release gates. They are not CBN-issued standards and cannot substitute for authorized staging evidence, independent approvals, provider permissions, or written regulatory authorization.

## Service scorecard

| Service | Functional evidence | Coverage evidence | Proposed gate | Score | Disposition |
|---|---|---|---|---:|---|
| Payment engine, Go | Race-enabled packages pass; PostgreSQL integration scenarios pass; Toxiproxy scenario skipped because no proxy URL is configured | Full aggregate **58.9% statements**; multirail PostgreSQL-tagged run **73.8%**; `PostgresUnknownStateStore`: Enqueue 82.6%, Claim 87.5%, Reschedule 62.5%, RecordDecision 84.6% | ≥80% aggregate statements plus database and distributed resilience evidence | **6.8/10** | **Conditional GO for tested paths; below aggregate gate** |
| Document intelligence, Python | Complete suite passes after PaddleOCR/Docling installation; Ollama transport mocks pass | **86% branch-aware** | ≥85% branch-aware | **9.0/10** | **GO on measured coverage gate** |
| Reporting analytics, Python | **88 passed, 2 skipped**; dependency stack installed; deprecation warnings remain | **83% branch-aware** | ≥80% branch-aware and reviewed skips | **8.0/10** | **GO on measured coverage; review skips/warnings** |
| Risk-compliance core, Rust | `cargo test --locked --all-features` passes | **82.51% lines**, 79.95% regions, 78.53% functions | ≥80% lines; function target tracked separately | **8.3/10** | **GO on line gate; function coverage below 80%** |
| Ledger gateway, Rust | `cargo test --locked --all-features` passes | 87.55% lines, 80.36% functions, 81.08% regions | ≥80% lines and functions | **9.0/10** | **GO on measured gate** |
| Control plane | 506 passed, 149 skipped across 108 files; explicit DB contract suite previously passed 111 tests with 16 skips | No unified microservice coverage gate in this run | Green suite; skips reviewed | **8.0/10** | **Conditional GO; external/live skips remain** |

## PostgreSQL coverage evidence

The first coverage command used an incorrect selector and ran no tests, producing a misleading 0% profile. That artifact is superseded. The corrected command used the repository’s `integration` build tag and the provisioned local database:

```bash
export UMOJA_TEST_DATABASE_URL='postgresql://.../umoja_test'
cd services/payment-engine
go test -race -count=1 -tags=integration \
  -coverprofile=../../artifacts/coverage/multirail-postgres-integration.coverprofile \
  ./multirail -run 'Postgres|Unknown|CrossReplica' -v
```

The corrected run passed the database-backed tests for cross-replica claim/payload binding, duplicate terminal-decision immutability, and stale-lease mutation rejection. The Toxiproxy test was **skipped**, not passed, because `UMOJA_TEST_TOXIPROXY_URL` was absent.

The multirail package profile measured **73.8% statements**. The store-specific results demonstrate that the main durable SQL paths are exercised:

| Function | Coverage |
|---|---:|
| `EnqueueUnknown` | 82.6% |
| `Claim` | 87.5% |
| `Reschedule` | 62.5% |
| `RecordDecision` | 84.6% |

The principal remaining SQL gap is `Reschedule`, especially database execution errors and the affected-row-count/lease-loss branch. Additional `RecordDecision` transaction-begin, insert-conflict, resolution-update, and query-error cases should be run against a controlled PostgreSQL fault-injection environment or a SQL-driver test double that preserves query semantics. The existing real-database evidence must remain the authority for row-locking and uniqueness behavior.

## Risk interpretation

The payment engine’s aggregate coverage remains below 80% because the full service includes provider adapters, signer/HSM runtime, workflow construction, webhook runtime, ledger paths, and operational failure handling. The PostgreSQL-tagged multirail run is stronger evidence for the durable store than the aggregate percentage, but it does not establish distributed network resilience because Toxiproxy was unavailable.

Risk-compliance-core now exceeds the proposed 80% line threshold at 82.51%, but its 78.53% function coverage indicates that several functions remain only partially exercised. Screening-provider live request/response branches and eventing transport failure paths are the next focus areas.

Document intelligence meets its proposed branch threshold, including Ollama non-2xx and malformed-JSON handling. Reporting analytics meets its measured threshold, but skipped tests and FastAPI deprecation warnings require explicit review before a production sign-off.

## Release gates and blockers

| Gate | Evidence | Status |
|---|---|---|
| Go payment-engine aggregate ≥80% | 58.9% statements | **NO-GO on proposed threshold** |
| Durable UNKNOWN-state SQL paths | Real PostgreSQL integration: claim, duplicate decision, stale lease, payload binding | **PASS for executed scenarios** |
| Reschedule SQL error/lease-loss completeness | 62.5% function coverage; fault-injection cases pending | **OPEN** |
| Distributed PostgreSQL/network partition evidence | Toxiproxy test skipped | **OPEN** |
| Rust risk-compliance line ≥80% | 82.51% lines | **PASS**, with function follow-up |
| Rust ledger line/function ≥80% | 87.55% / 80.36% | **PASS** |
| Python document-intelligence branch ≥85% | 86% | **PASS** |
| Python reporting branch ≥80% | 83%; 2 skipped | **PASS WITH REVIEW** |
| Control-plane functional suite | 506 passed, 149 skipped | **CONDITIONAL** |
| Live CBN restricted-pilot authorization | Not evidenced in local execution | **NO-GO until authorized evidence exists** |

## Evidence files

- `artifacts/coverage/multirail-postgres-integration.log`
- `artifacts/coverage/multirail-postgres-integration.txt`
- `artifacts/coverage/multirail-postgres-integration.coverprofile`
- `artifacts/coverage/payment-engine-after-webhook.txt`
- `artifacts/coverage/rust-risk/after-screening.txt`
- `artifacts/coverage/rust-ledger/final.txt`
- `artifacts/coverage/document-intelligence-final-aggregate.txt`
- `artifacts/coverage/reporting-analytics-test.log`
- `artifacts/multirail-test-list-integration.txt`

## Final score

Using the evidence-weighted service scores above, the simple average is **8.0/10 for technical test readiness**. This score is not a regulatory approval score. The decisive release disposition remains **Technical GO with open engineering gates; Regulatory NO-GO for live activation** until the Go aggregate target, `Reschedule` SQL error coverage, distributed Toxiproxy evidence, skipped-test review, and authorized regulatory evidence are complete.
