# Cross-Service Compliance and RBAC Verification Report

## Decision

The executable cross-service compliance matrix passed all configured local checks. The evidence supports **Technical GO for the exercised RBAC, role-isolation, database-boundary, and service test paths**. External/live integrations remain explicitly skipped where their backends or credentials were not configured; those skips are not represented as passes.

## Matrix results

| Suite | Exit | Duration | Result |
|---|---:|---:|---|
| Control-plane security/preflight/type check | 0 | 7.07 s | 3/3 security tests passed. |
| Control-plane full Vitest suite with explicit PostgreSQL URLs | 0 | 104.84 s | 80 files passed, 28 skipped; 506 tests passed, 149 skipped. |
| Go RBAC/multirail/provider suite with integration tag and PostgreSQL | 0 | 2.31 s | `multirail`, `enterprisecontrol`, and `provider` packages passed under the race detector. |
| Rust risk-compliance-core | 0 | 1.65 s | Locked all-feature test suite passed. |
| Rust ledger-gateway | 0 | 0.38 s | Locked all-feature test suite passed. |
| Reporting analytics with `-W error` | 0 | 9.50 s | 88 passed, 2 intentional skips; socket/resource warnings resolved. |

## RBAC and role-isolation evidence

The control-plane tests cover application-level role boundaries for compliance officers, treasury operators, auditors, administrators, and unauthenticated users. Counterparty onboarding tests verify that unauthorized roles are rejected before record validation, while authorized paths are allowed to reach domain validation. This prevents a permission denial from being confused with a missing-record response and demonstrates separation between authority and data existence.

The control-plane suite also validates KYC evidence visibility, credential activation permissions, service-health access, segregation-of-duties monitoring, role-authority matrices, payment workflow boundaries, and provider endpoint restrictions. The PostgreSQL boundary check confirms that the application role is not granted schema creation or database creation authority. The real database-backed multirail tests additionally validate that independent connections cannot both claim the same UNKNOWN reconciliation item and that stale lease tokens cannot mutate durable state.

The Go enterprise-control and multirail/provider packages passed under the race detector, providing concurrent permission and execution-path evidence. Rust compliance and ledger tests passed with locked dependencies and all declared features.

## Skips and external dependencies

The control-plane suite reports 28 skipped test files and 149 skipped tests. These are intentionally live/external integrations, including regulatory deadlines, role-resolver or provider-backed paths, and other environment-gated checks. They are not failures, but they remain conditional evidence until the required staging services, credentials, and authorized channels are configured.

Reporting analytics reports 2 skipped tests. The strict warning gate now passes, so the previous Starlette/httpx2 compatibility warning, FastAPI startup deprecation, and local HTTP-server socket leaks are resolved. The remaining skips are external/service-dependent and should be executed in staging when their dependencies are authorized and available.

## Evidence files

- `artifacts/compliance-matrix/summary.tsv`
- `artifacts/compliance-matrix/control_security_check.log`
- `artifacts/compliance-matrix/control_full_tests.log`
- `artifacts/compliance-matrix/go_rbac_multirail.log`
- `artifacts/compliance-matrix/rust_risk_tests.log`
- `artifacts/compliance-matrix/rust_ledger_tests.log`
- `artifacts/compliance-matrix/reporting_strict.log`
- `artifacts/final-suites/reporting-analytics-werror-cleanup.log`

## Limitations

This report demonstrates local and provisioned-test-database behavior. It does not establish live CBN authorization, production provider permissions, real customer activity, or the availability of every external service represented by skipped tests. Regulatory activation therefore remains **NO-GO** until authorized staging evidence and independent approvals are complete.
