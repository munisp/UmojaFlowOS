# UmojaFlowOS Microservice Coverage and Production-Readiness Report

## Executive conclusion

The measured service coverage is heterogeneous. The Go payment engine reports **54.8% statement coverage**, below the proposed critical-service target of 80%. Document intelligence reports **86% branch-aware coverage**, meeting its proposed 85% target. Reporting-analytics completed **88 passed and 2 skipped tests**, but its final coverage percentage is recorded only when the coverage report artifact is present. Rust services passed their test suites, but line coverage was not measured because no Rust coverage instrument is installed.

> These thresholds are engineering release-gate targets proposed for this report; they are not presented as a regulator-issued standard. Coverage is evidence of exercised code, not proof of correctness or regulatory authorization.

## Service matrix

| Service | Measured coverage | Proposed target | Status | Test evidence |
|---|---:|---:|---|---|
| payment-engine (Go) | 54.8% | 80% | BELOW TARGET | go test -race -coverprofile; all package tests passed |
| document-intelligence (Python) | 86.0% | 85% | PASS | 43 tests passed; branch-aware coverage |
| reporting-analytics (Python) | 83.0% | 80% | PASS | 88 passed, 2 skipped; coverage artifact available only if report file exists |
| risk-compliance-core (Rust) | Not measured | 80% | NOT MEASURED | cargo test --locked passed; cargo-llvm-cov/grcov not installed |
| ledger-gateway (Rust) | Not measured | 80% | NOT MEASURED | cargo test --locked passed; cargo-llvm-cov/grcov not installed |

## Key risk interpretation

The Go aggregate improved after adding signer-runner and load-test helper tests, but the payment engine remains below the proposed release threshold. The most material uncovered paths are the PostgreSQL durable UNKNOWN-state store, Yellow Card webhook/runtime configuration, workflow client/worker construction, and provider failure normalization. Build-tagged PostgreSQL integration tests pass separately but are not included in the ordinary unit coverage profile, which explains why `postgres_store.go` remains at 0% in that profile.

Document intelligence improved to 86% branch-aware coverage after adding transport mocks. The new tests cover non-2xx responses, malformed model/tag/chat JSON, unapproved model digests, and invalid structured output. Remaining gaps are primarily provenance resolver remote/fallback branches and Ollama operational branches not reached by the current fixtures.

Reporting-analytics has a passing functional suite with two skips and emitted FastAPI deprecation warnings. Its dependency installation required the declared Redis/Boto3 stack; coverage should be regenerated in CI and enforced as an artifact.

Rust risk-compliance-core and ledger-gateway tests pass under Rust 1.89.0, but a production coverage decision cannot be made until `cargo-llvm-cov` or an equivalent instrument is installed and run. The control-plane suite recorded 506 passed and 149 skipped tests; it is an application suite, not one of the `services/` microservice coverage percentages.

## Recommended release gates

| Gate | Requirement | Current disposition |
|---|---|---|
| Critical payment logic | ≥80% statement coverage plus race and database integration evidence | **NO-GO on coverage target**; race/unit and PostgreSQL integration tests pass, but aggregate coverage is 54.8% |
| Document intelligence | ≥85% branch-aware coverage and all engine-availability tests pass | **GO on measured gate** at 86%; retain external model/runtime checks |
| Reporting analytics | ≥80% branch-aware coverage and no unreviewed skipped critical tests | **Pending coverage artifact review**; functional suite is green with 2 skips |
| Rust services | ≥80% line coverage plus locked tests | **Not measurable yet**; install Rust coverage tooling |
| Live distributed resilience | Toxiproxy/PostgreSQL latency run with two independent replicas | **Not evidenced in sandbox**; requires staging infrastructure |

## Artifacts

- `artifacts/coverage/payment-engine-final-aggregate.txt`
- `artifacts/coverage/document-intelligence-final-aggregate.txt`
- `artifacts/coverage/reporting-analytics-test.log`
- `artifacts/coverage/final_microservice_coverage.json`
- `artifacts/coverage/payment-engine-final-aggregate.coverprofile`

## Final readiness statement

**Technical readiness is improved but not a universal GO.** Document intelligence meets the proposed coverage threshold and its tests are green. Reporting analytics and both Rust services have green functional tests, but coverage evidence needs formalization. The payment engine remains below the proposed critical-service threshold and must not be represented as production-ready solely from this report. Live CBN activation remains dependent on staging evidence, provider authorization, operational controls, and independent regulatory approvals.
