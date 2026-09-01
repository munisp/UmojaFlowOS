# Internal gRPC Settlement Adoption and mTLS Runbook

## Scope

The internal settlement gRPC service is an optimization boundary for service-to-service calls. HTTP provider APIs and provider webhooks remain HTTP. PostgreSQL and TigerBeetle remain authoritative for workflow and financial accounting. The gRPC service cannot bypass screening, idempotency, reconciliation, or release controls.

## Contract and generated SDKs

The versioned contract is:

```text
api/proto/umoja/settlement/v1/settlement.proto
```

Generated clients are stored under:

```text
services/payment-engine/internal/settlement/gen/umoja/settlement/v1/
sdk/python/umoja/settlement/v1/
sdk/typescript/umoja/settlement/v1/settlement.ts
```

Regenerate with `protoc` and pinned plugins. CI must fail when generated output differs from the checked-in contract.

## Production configuration

The service must listen on a TLS-only port such as `8443`. Required settings are:

```text
SETTLEMENT_GRPC_TARGET=payment-engine.umoja.svc.cluster.local:8443
SETTLEMENT_GRPC_CA_FILE=/var/run/secrets/settlement/ca.crt
SETTLEMENT_GRPC_CLIENT_CERT_FILE=/var/run/secrets/settlement/tls.crt
SETTLEMENT_GRPC_CLIENT_KEY_FILE=/var/run/secrets/settlement/tls.key
SETTLEMENT_GRPC_SERVER_NAME=payment-engine.umoja.svc.cluster.local
```

The Go helper enforces TLS 1.3, a trusted CA pool, a client certificate/key pair, and server-name verification. Plaintext dialing must be limited to bufconn tests and explicitly local development.

## Service mesh

Apply `infra/service-mesh/settlement-grpc-mtls.yaml` only in the approved namespace. Istio must run in `STRICT` mTLS mode. The AuthorizationPolicy allowlists only the control-plane and reconciliation-worker service accounts on port 8443. The DestinationRule uses HTTP/2 gRPC transport, connection bounds, and outlier ejection.

Before promotion, verify:

```bash
istioctl analyze -n umoja
kubectl -n umoja get peerauthentication,authorizationpolicy,destinationrule
kubectl -n umoja auth can-i create --as=system:serviceaccount:umoja:control-plane
```

The last command is only a Kubernetes RBAC check; application access must also be tested through an authenticated gRPC call.

## Benchmark method

Run the local synthetic benchmark:

```bash
go test ./services/payment-engine/internal/settlement \
  -run '^$' -bench BenchmarkSettlementTransport \
  -benchmem -benchtime=3s -count=3
```

The benchmark compares gRPC over `bufconn` with the legacy HTTP JSON adapter under equivalent synthetic responses. It is a transport comparison, not an end-to-end provider or network benchmark. Repeat in authorized staging with TLS, service mesh, real service CPU limits, and representative payload sizes before changing SLOs or capacity plans.

## Failure behavior

A gRPC deadline, TLS failure, unavailable sidecar, or malformed response must map to an UNKNOWN/held outcome according to the settlement state machine. The caller must not retry with a new idempotency key. Retries are permitted only with the identical request identity and only when non-submission is proven. Mesh outlier ejection must not be interpreted as proof of non-submission.

## Telemetry

Emit OTel spans and metrics for request count, latency, deadline exceeded, TLS/auth failure, unavailable status, and response validation failure. Do not record raw payment payloads, account numbers, wallet addresses, credentials, or document contents. Tenant labels must be bounded and authorization-controlled.

## Rollback

To roll back the gRPC optimization, route internal callers to the existing HTTP/service boundary without changing the canonical request identity. Do not change ledger state or generate a second provider submission. Preserve gRPC error and latency evidence for the incident record.

## Release gate

Production enablement requires successful generated-code checks, unit/integration tests, mTLS handshake evidence, negative authorization tests, mesh-policy validation, load results, alert routing, four-role release approval, and an immutable evidence manifest bound to the deployed release SHA.

## Typed protobuf SDK verification (2026-09-01)

The internal settlement boundary uses the generated `SettlementRequest`, `SettlementQueryRequest`, and `SettlementResponse` protobuf messages. It does not use `google.protobuf.Struct`. Every Execute and Query response must contain a non-empty `state` and a SHA-256 `payload_sha256` matching the canonical request payload. A missing, malformed, or mismatched digest is converted to the fail-closed `UNKNOWN` outcome; callers must not retry or settle an ambiguous result.

The reproducible local verification sequence is:

```bash
cd services/payment-engine
go test ./... -count=1 -timeout=15m
go build -o /tmp/settlement-grpc-test-server ./cmd/settlement-grpc-test-server
/tmp/settlement-grpc-test-server --addr 127.0.0.1:18443 &
cd ../..
SETTLEMENT_GRPC_CI=1 SETTLEMENT_GRPC_TARGET=127.0.0.1:18443 \
  PYTHONPATH=sdk/python python3 -m unittest discover -s sdk/python/tests \
  -p 'test_settlement_grpc_integration.py' -v
SETTLEMENT_GRPC_CI=1 pnpm --dir apps/control-plane exec vitest run \
  server/typedSettlementGrpc.integration.test.ts --reporter=verbose
```

The pull-request workflow repeats this procedure from a clean checkout. It builds the Go test server, runs the generated Python client, runs the generated TypeScript client, and checks that the generated stub files are present. Production deployments must replace the local insecure channel with the configured mTLS channel and must retain the same payload-binding and UNKNOWN-state semantics.

The local benchmark `BenchmarkSettlementTransportTLSLatency` was run with a simulated 2 ms provider latency. Three samples produced approximately **2.45 ms/op for gRPC over TLS** and **2.38 ms/op for HTTP over TLS** in this loopback harness. This is not a production throughput claim: the current benchmark creates a per-operation client connection, so it measures connection/setup overhead rather than pooled high-throughput behavior. A follow-up pooled-connection benchmark is required before claiming a performance advantage. The typed schema nevertheless provides a stable cross-language contract and removes generic Struct decoding from the settlement path.
