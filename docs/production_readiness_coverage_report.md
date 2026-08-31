# UmojaFlowOS Microservice Coverage and Production-Readiness Report

## Executive conclusion

The new coverage instrumentation and targeted tests produced materially stronger evidence, but the proposed 80% critical-service gate is not universally met. The Rust ledger gateway passes the line and function thresholds. The Rust risk-compliance core is close on line coverage but remains below the 80% line target. The Go payment engine improved to **56.3% statement coverage**, but remains below the proposed 80% critical-service target because database-backed reconciliation and provider-runtime branches require more integration coverage.

> These thresholds are engineering release-gate targets proposed for this report; they are not CBN-issued coverage standards. Coverage demonstrates exercised code, not correctness, operational resilience, or regulatory authorization.

## Measured service matrix

| Service | Coverage dimensions | Measured result | Proposed target | Disposition |
|---|---|---:|---:|---|
| Payment engine, Go | Statements | **56.3%** | 80% | **Below target** |
| Document intelligence, Python | Branch-aware | **86%** | 85% | **Meets target** |
| Reporting analytics, Python | Branch-aware | **83%**; 88 passed, 2 skipped | 80% | **Meets measured target; review skips** |
| Risk-compliance core, Rust | Regions / functions / lines | **74.84% / 71.97% / 78.25%** | 80% line and function | **Below target** |
| Ledger gateway, Rust | Regions / functions / lines | **81.08% / 80.36% / 87.55%** | 80% line and function | **Meets target** |

## Rust coverage instrumentation

Installed and verified:

```text
cargo-llvm-cov 0.9.0
rustc 1.89.0
llvm-tools-preview
```

The coverage commands were executed with locked dependencies and all features:

```bash
cd services/risk-compliance-core
cargo llvm-cov --locked --all-features --summary-only

cd services/ledger-gateway
cargo llvm-cov --locked --all-features --summary-only
```

Both services’ test suites completed successfully. The risk-compliance core needs additional negative-path and policy-combination tests before it can meet the proposed 80% line/function gate. The ledger gateway meets the proposed coverage threshold on both dimensions.

## Payment-engine targeted tests

Added deterministic unit tests in `services/payment-engine/multirail/postgres_store_unit_test.go` for the fail-closed durable-store helpers and pre-database validation paths. These tests cover nil-store rejection, safe lease defaults, invalid enqueue rejection, invalid decision rejection, payload digest binding, status normalization, timestamp normalization, and UUIDv4 lease-token shape.

The existing PostgreSQL integration suite continues to cover the actual durable guarantees: duplicate terminal-decision immutability, stale-lease rejection, payload binding, and cross-connection single-flight claim exclusivity. Those tests are intentionally structured as integration tests because their guarantees depend on PostgreSQL transaction and unique-index semantics.

Added Yellow Card webhook runtime matrix tests for provider enablement, settlement prohibition, production-only transport, TLS controls, exact HTTPS public URL validation, numeric age/body limits, and CIDR allowlist validation. The targeted race tests pass:

```text
ok github.com/munisp/UmojaFlowOS/services/payment-engine/multirail
ok github.com/munisp/UmojaFlowOS/services/payment-engine/internal/provider
```

The new tests raised the Go aggregate from 54.8% to **56.3% statements**. They did not approach 80% because the payment engine contains substantial database, provider, signer, workflow, and operational runtime code that cannot be covered by small pure unit tests alone.

## Remaining Go risk paths

The highest-priority uncovered paths are `PostgresUnknownStateStore.EnqueueUnknown`, `Claim`, `Reschedule`, and `RecordDecision` under database errors and SQL result variants; Yellow Card webhook durable file evidence and queue persistence; Redis replay-store error handling; webhook runtime success construction with valid managed secrets and CA material; and provider/HSM runtime startup and retry-exhaustion combinations.

The correct next step is not to inflate unit coverage with mocks that bypass the security boundary. The next release gate should add a repeatable PostgreSQL integration coverage job, a Redis/TLS webhook integration job, and provider-runtime configuration tests with ephemeral secret files and a generated test CA.

## Release-gate conclusion

| Gate | Current result |
|---|---|
| Payment engine at ≥80% statements | **NO-GO**; 56.3% measured |
| Durable UNKNOWN-state integration evidence | **PASS for executed scenarios**; retain staging repeatability evidence |
| Yellow Card webhook fail-closed runtime tests | **PASS for targeted validation matrix**; durable Redis/file success path remains to be exercised |
| Document intelligence at ≥85% branch-aware coverage | **PASS** at 86% |
| Reporting analytics at ≥80% branch-aware coverage | **PASS on measured coverage**, with two skipped tests and deprecation warnings requiring review |
| Risk-compliance core at ≥80% line/function coverage | **NO-GO on proposed threshold**; 78.25% line and 71.97% function coverage |
| Ledger gateway at ≥80% line/function coverage | **PASS** at 87.55% line and 80.36% function coverage |
| Live distributed PostgreSQL/Toxiproxy evidence | **Not evidenced in this sandbox**; requires staging infrastructure |

The platform should therefore remain **Technical GO for the tested paths but not universal production GO on coverage gates**. Live CBN activation remains dependent on authorized staging evidence, provider permissions, operational controls, independent approvals, and written regulatory authorization.

## Evidence artifacts

- `artifacts/coverage/rust-risk/final.txt`
- `artifacts/coverage/rust-ledger/final.txt`
- `artifacts/coverage/payment-engine-after-targeted.txt`
- `artifacts/targeted-go-tests.log`
- `services/payment-engine/multirail/postgres_store_unit_test.go`
- `services/payment-engine/internal/provider/yellowcard_webhook_test.go`


## Coverage update: risk-compliance-core and webhook integration

After installing `cargo-llvm-cov 0.9.0`, targeted screening tests raised risk-compliance-core line coverage to **82.51%**, exceeding the proposed 80% line threshold. The measured region/function/line summary is **79.95% / 78.53% / 82.51%**. Function coverage remains below 80%, so the service is above the line gate but not above a combined line-and-function gate. The largest remaining file-level gap is `src/screening.rs`, especially live provider request/response branches; `eventing.rs` also retains transport failure branches.

The new Rust tests cover blank and oversized screening fields, malformed and insecure endpoint forms, HTTP loopback policy, managed file-secret root binding, missing/short/escaped secret material, and fail-closed environment construction.

The payment engine now includes a local TLS RESP integration harness for the Redis replay store and filesystem integration tests for immutable evidence and reconciliation queue records. The harness verifies successful TLS reservation, existing-key null-bulk behavior, authentication/protocol failure handling, invalid dependency rejection, duplicate evidence idempotency, payload conflict rejection, queue creation, and blank-directory rejection. The provider integration package passes under the race detector.

The post-integration Go aggregate is **58.9% statement coverage**. The webhook-specific functions improved to approximately **66.7% for RESP writing, 59.1% for RESP parsing, and 76.9% for durable evidence writing**. `WebhookRuntimeFromEnvironment` remains at 44.2% because a fully successful construction requires a valid managed secret tree, a valid Redis CA bundle, and a production-like Redis address; the next staging test should exercise that constructor with an ephemeral CA and TLS Redis service. The PostgreSQL store’s SQL branches likewise require coverage from the existing real-database integration suite and a coverage-enabled PostgreSQL job; pure unit tests intentionally do not fake transaction semantics.

These results improve technical evidence but do not raise the payment engine to the proposed 80% aggregate gate. CBN live activation remains dependent on authorized staging evidence, provider permissions, independent approvals, and written regulatory authorization.
