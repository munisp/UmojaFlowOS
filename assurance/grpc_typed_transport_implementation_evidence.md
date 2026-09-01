# Typed gRPC Settlement Transport — Implementation Evidence

**Date:** 2026-09-01
**Scope:** Internal settlement boundary for UmojaFlowOS
**Decision posture:** Technically validated; production enablement remains conditional on mTLS staging evidence, pooled-load capacity results, and the existing four-role release approval.

## Completed implementation

The settlement service now maps directly to generated protobuf messages: `SettlementRequest`, `SettlementQueryRequest`, and `SettlementResponse`. The transport no longer depends on `google.protobuf.Struct`. Request conversion validates required identity fields, canonical payload presence, SHA-256 binding, and RFC3339 expiry. Response conversion requires a non-empty state and an exact case-insensitive SHA-256 match; any ambiguity maps to the existing fail-closed `UNKNOWN` outcome.

The Go implementation uses `crypto/sha256.Sum256` for deterministic payload binding. The response mapping is aligned with the generated protobuf naming convention (`AttestationId`); the domain `ProviderResult` has no attestation field, so the transport leaves that optional field empty rather than inventing a value.

A local Go test server was added at `services/payment-engine/cmd/settlement-grpc-test-server`. It is a CI fixture only and uses an insecure loopback channel; it is not a production deployment artifact.

## Verification evidence

| Check | Result | Evidence |
|---|---:|---|
| Go settlement package with race detector | PASS | `go test -race ./internal/settlement -count=1` |
| Full payment-engine Go suite | PASS | `go test ./... -count=1 -timeout=15m` |
| Python generated SDK against Go service | PASS | 1 test passed; `test_settlement_grpc_integration.py` |
| TypeScript generated SDK against Go service | PASS | 1 test passed; `typedSettlementGrpc.integration.test.ts` |
| Repository whitespace check | PASS | `git diff --check` |
| CI automation | ADDED | `.github/workflows/settlement-grpc-sdk-integration.yml` |

## Benchmark interpretation

The pooled benchmark `BenchmarkSettlementPooledConcurrent` reused one gRPC connection and exercised concurrent workers with an injected 10 ms service-mesh-latency budget. Across three samples, the median observed latency was approximately **10.64 ms/op at one worker**, **2.68 ms/op at four workers**, and **0.684 ms/op at sixteen workers**. These are concurrent aggregate-operation timings from a loopback synthetic harness, not per-request tail latency or a production SLO. They show that the shared connection and server can process concurrent work, but do not constitute Istio capacity evidence.

## Fail-closed acceptance criteria

A malformed request, missing payload digest, mismatched digest, deadline, TLS failure, unavailable sidecar, or malformed response must hold settlement in `UNKNOWN`/non-terminal state. No caller may retry with a new idempotency key. Any retry permitted by the coordinator must preserve the original identity and prove non-submission.

## Remaining production gate

The pooled local benchmark and executable mTLS/authorization tests are complete. The mTLS test proves a TLS 1.3 client certificate is accepted, a missing client certificate is rejected, an allowlisted `control-plane` principal is accepted, and an unallowlisted principal receives `PermissionDenied`. This sandbox has no `kubectl`, `istioctl`, or reachable Kubernetes cluster, so direct Istio sidecar latency, PeerAuthentication, AuthorizationPolicy, and service-account principal evidence remains a staging gate. Before production enablement, run the same suite through the authorized staging mesh, capture OTel telemetry and alert-routing evidence, and bind artifacts to the release SHA and four distinct approvals in the immutable evidence manifest.
