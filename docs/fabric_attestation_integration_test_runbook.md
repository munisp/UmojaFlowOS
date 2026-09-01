# Fabric Attestation Integration Test Runbook

## Scope and safety boundary

Fabric is an attestation-only consortium layer. TigerBeetle remains the authoritative double-entry ledger and PostgreSQL remains the durable settlement/idempotency store. A Fabric error, timeout, partition, invalid endorsement, or digest mismatch must hold the associated evidence/settlement state and must never authorize a financial posting.

## Context and commit-timeout behavior

`GatewayClient.SubmitAttestation` now calls the Fabric Gateway v1.12 `Contract.SubmitWithContext` API. The caller context therefore bounds proposal endorsement, orderer submission, and commit-status waiting. A nil context is replaced with `context.Background()` for defensive compatibility, but production callers must always provide a deadline.

`UMOJA_FABRIC_COMMIT_STATUS_TIMEOUT` is parsed as a Go duration and is bounded to a positive value no greater than five minutes. The default is 30 seconds. The value is passed to `fabric.WithCommitStatusTimeout` when the Gateway is constructed. A timeout or cancellation is an error/UNKNOWN condition; the caller must reconcile read-only and must not blindly submit again.

## Local suite

Run the race-enabled client, partition, Byzantine, and chaincode tests:

```bash
scripts/infra/run_fabric_attestation_integration.sh
```

The default suite does not require a Fabric network. It executes the in-memory partition and Byzantine gateway tests and the chaincode unit suite. It is safe for CI and verifies that no simulated partition is accepted and that duplicate blind retry behavior is not introduced by the client layer.

## Live duplicate-prevention test

Set `FABRIC_LIVE=1` only in an approved staging environment. The following variables must reference test-only evidence and an approved consortium channel:

```bash
export UMOJA_FABRIC_ENDPOINT=grpcs://gateway.example:7051
export UMOJA_FABRIC_TLS_ROOT_CERT_PATH=/run/secrets/fabric/ca.crt
export UMOJA_FABRIC_IDENTITY_CERT_PATH=/run/secrets/fabric/client.crt
export UMOJA_FABRIC_IDENTITY_KEY_PATH=/run/secrets/fabric/client.key
export UMOJA_FABRIC_MSP_ID=Org1MSP
export UMOJA_FABRIC_CHANNEL=umoja-channel
export UMOJA_FABRIC_CHAINCODE=consortium-attestation
export UMOJA_FABRIC_COMMIT_STATUS_TIMEOUT=30s
export FABRIC_TEST_RELEASE_SHA=0123456789abcdef0123456789abcdef01234567
export FABRIC_TEST_EVIDENCE_ID=E-TEST-FABRIC-DUPLICATE
export FABRIC_TEST_EVIDENCE_URI=staging/evidence/E-TEST-FABRIC-DUPLICATE.json
export FABRIC_TEST_ENDORSEMENT_SCOPE=Org1MSP-Org2MSP
export FABRIC_TEST_EVIDENCE=approved-staging-test-evidence
export FABRIC_LIVE=1
scripts/infra/run_fabric_attestation_integration.sh
```

The test submits one attestation, requires a non-empty deterministic attestation ID, submits the identical request again, and requires the second submission to fail. It then performs a read-only digest verification. A duplicate success, missing ID, failed verification, or digest mismatch fails the suite.

The exact environment variable prefix used by the Go live test is `UMOJA_FABRIC_`; the endpoint variable is `UMOJA_FABRIC_ENDPOINT` for the test helper and `UMOJA_FABRIC_GATEWAY_ENDPOINT` for the production runtime loader. Staging automation should export both names to avoid an accidental mismatch between test and runtime composition.

## Live partition test

Partition testing must be performed by an authorized network-chaos operator using a reversible network policy, Toxiproxy route, or service-mesh fault injection. The test must not mutate the production channel or delete ledger state. Configure a blackholed Gateway endpoint under the `UMOJA_FABRIC_PARTITION_*` prefix, set `FABRIC_LIVE_PARTITION=1`, and run:

```bash
scripts/infra/run_fabric_attestation_integration.sh
```

The test uses a two-second context deadline and requires the submission to fail. The surrounding staging procedure must then restore the route, query the original attestation ID read-only, and prove that no blind duplicate submission occurred. Capture the network-fault declaration, Gateway error, context deadline, query result, client metrics, and immutable evidence record.

## Assertions and evidence

| Test area | Required assertion | Evidence |
|---|---|---|
| Context cancellation | Gateway submit returns before the caller deadline | Test output and latency metric |
| Commit timeout | Timeout is bounded by configured maximum | Runtime configuration and Gateway error |
| Partition | Submit does not succeed while the Gateway is unreachable | Fault-injection record and test log |
| Recovery | Read-only verification succeeds after route restoration | Query response and digest binding |
| Duplicate prevention | Identical deterministic request cannot create a second record | Chaincode error and attestation query |
| Concurrent duplicates | Concurrent identical requests result in one committed record or explicit conflicts | Fabric commit and chaincode logs |
| Binding | Release SHA, evidence ID, and digest remain unchanged | Returned record and SHA-256 manifest |
| Attestation-only | Fabric failure cannot post or alter TigerBeetle balances | Ledger reconciliation evidence |

## Production gate

Mock and local chaincode tests are necessary but not sufficient for production approval. The live gate requires real independent MSP identities, approved CA chains, HSM-backed signing, channel and endorsement-policy lifecycle evidence, commit-status and partition tests, backup/restore evidence, tenant-safe OTel telemetry, alert delivery, WORM retention, and independent release approvals.
