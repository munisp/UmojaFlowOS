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

`BenchmarkSettlementTransportTLSLatency` was run three times with a simulated 2 ms provider latency. The local loopback harness measured approximately **2.45 ms/op for gRPC over TLS** and **2.38 ms/op for HTTP over TLS**. This does not demonstrate that gRPC is slower in production: the benchmark creates a client connection per operation and therefore includes connection/setup overhead. The typed protobuf change removes generic Struct decoding and establishes a stable cross-language contract, but capacity claims require a follow-up benchmark with pooled connections, representative payloads, concurrent workers, TLS termination, and Istio service-mesh latency.

## Fail-closed acceptance criteria

A malformed request, missing payload digest, mismatched digest, deadline, TLS failure, unavailable sidecar, or malformed response must hold settlement in `UNKNOWN`/non-terminal state. No caller may retry with a new idempotency key. Any retry permitted by the coordinator must preserve the original identity and prove non-submission.

## Remaining production gate

Before production enablement, run the pooled-connection gRPC-versus-HTTP benchmark in authorized staging, capture mTLS and Istio authorization evidence, confirm tenant-safe OTel telemetry, validate alert routing, and bind the resulting artifacts to the release SHA and four distinct approvals in the immutable evidence manifest.
