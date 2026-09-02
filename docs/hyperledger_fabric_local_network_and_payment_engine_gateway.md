# Hyperledger Fabric Local Network and Payment-Engine Gateway Guide

## Purpose and boundary

This guide provisions a local Hyperledger Fabric test network for the UmojaFlowOS consortium-attestation proof of concept and connects the payment engine to Fabric Gateway. Fabric is an external attestation layer only. It must never authorize a customer payment, create a TigerBeetle posting, mutate PostgreSQL settlement state, or act as a fallback execution rail.

Fabric client applications should use Fabric Gateway for evaluate, endorse, submit, commit-status, and chaincode-event flows. [1] The chaincode uses the supported Go Contract API. [2]

## Prerequisites

Install Docker with Compose support, Go 1.25.4 or the repository-pinned Go toolchain, OpenSSL, and the official `hyperledger/fabric-samples` repository with the Fabric binaries and images downloaded. Do not download binaries from an unverified mirror. The local network is for synthetic evidence only.

Set:

```bash
export FABRIC_SAMPLES_DIR=$HOME/src/fabric-samples
export FABRIC_CHANNEL=umoja-channel
export FABRIC_CHAINCODE=consortium-attestation
```

Verify:

```bash
test -x "$FABRIC_SAMPLES_DIR/test-network/network.sh"
docker version
peer version
```

## Provision the network

From the repository root:

```bash
scripts/infra/fabric_attestation_network.sh up
scripts/infra/fabric_attestation_network.sh deploy
```

The script resets the local network, starts the certificate authorities, creates the configured channel, and deploys the Go chaincode from:

```text
integrations/hyperledger-fabric/consortium-attestation/chaincode-go
```

For a local smoke invocation:

```bash
FABRIC_SMOKE_RELEASE_SHA=0123456789abcdef0123456789abcdef01234567 \\
FABRIC_SMOKE_EVIDENCE_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \\
scripts/infra/fabric_attestation_network.sh smoke
```

The smoke run must record the transaction ID, commit status, chaincode event, attestation ID, release SHA, and evidence digest. It must not contain evidence contents, account IDs, KYC data, credentials, or private keys.

## Configure the payment engine

The concrete Gateway adapter is located at:

```text
services/payment-engine/internal/attestation/fabric_gateway.go
```

The runtime configuration is validated by:

```text
services/payment-engine/internal/attestation/config.go
```

Configure the following through the secret manager or local-only test environment:

```text
UMOJA_FABRIC_ATTESTATION_ENABLED=true
UMOJA_FABRIC_ATTESTATION_ONLY=true
UMOJA_FABRIC_GATEWAY_ENDPOINT=grpcs://localhost:7051
UMOJA_FABRIC_TLS_ROOT_CERT_PATH=/path/to/tls/ca.crt
UMOJA_FABRIC_IDENTITY_CERT_PATH=/path/to/org1/admin/signcerts/cert.pem
UMOJA_FABRIC_IDENTITY_KEY_PATH=/path/to/org1/admin/keystore/key.pem
UMOJA_FABRIC_MSP_ID=Org1MSP
UMOJA_FABRIC_CHANNEL=umoja-channel
UMOJA_FABRIC_CHAINCODE=consortium-attestation
```

The startup validator rejects missing certificate files, non-`grpcs` endpoints, and any setting that disables attestation-only mode. Production private keys must not be placed in the repository, container image, logs, or evidence bundle.

The platform integration sequence is:

```text
PostgreSQL evidence record
  → canonical evidence SHA-256
  → TigerBeetle accounting/reconciliation result
  → Fabric CreateAttestation
  → commit status and attestation ID
  → PostgreSQL Fabric reference
  → read-only VerifyDigest during audit
```

A Fabric failure must produce an attestation backlog or release hold. It must not trigger another provider payment submission or a ledger reversal.

## Channel and endorsement policy

The local example uses Org1 and Org2. For a consortium deployment, channel membership, MSP identities, chaincode definition, endorsement policy, private-data collection policy, and certificate authority ownership must be approved by the participating organizations.

Use an endorsement policy that requires the organizations whose attestation is being represented. Do not place raw customer or payment data in public channel state. Use evidence URI plus digest only, and use private-data collections only when the consortium requirement and retention policy justify them. Fabric private data distributes the private value to authorized peers while recording a hash on the shared ledger. [3]

## Adapter behavior

`GatewayClient.SubmitAttestation` performs the chaincode submission and validates that the returned record contains the requested release SHA, evidence ID, and digest. `GatewayClient.EvaluateAttestation` uses a read-only evaluation call. The adapter does not expose a settlement method.

The adapter must be called only after the PostgreSQL evidence record and TigerBeetle result are durable. If the Gateway returns a timeout after submission may have occurred, the caller must retain an UNKNOWN attestation state and query by deterministic attestation ID; it must not submit a second attestation blindly.

## Test and validation commands

```bash
cd services/payment-engine
$REPO_GO test -race ./internal/attestation ./internal/provider ./multirail -count=1

cd integrations/hyperledger-fabric/consortium-attestation/chaincode-go
$REPO_GO test ./... -count=1

cd "$FABRIC_SAMPLES_DIR/test-network"
./network.sh down
```

Required tests include valid digest binding, duplicate attestation rejection, malformed release SHA, malformed evidence SHA, Gateway timeout, commit-status failure, read-only evaluation, certificate failure, and no-settlement-on-attestation-failure.

## Rollback

To roll back the local network:

```bash
scripts/infra/fabric_attestation_network.sh down
```

To roll back the payment-engine integration, disable the attestation component through the approved runtime configuration while preserving PostgreSQL and TigerBeetle settlement behavior. Never delete committed Fabric evidence or rewrite PostgreSQL audit records. Open a corrective-action record for any failed chaincode lifecycle, endorsement, commit, or digest-verification test.

## Promotion gates

A local network pass is not a consortium production pass. Promotion requires at least two independent organizations, approved MSP/CA governance, endorsement-policy approval, private-data and retention review, Gateway mTLS, HSM-backed signing where required, chaincode lifecycle approval, backup/restore, peer/orderer failure drills, evidence WORM retention, OTel/Alertmanager coverage, and E-09 independent sign-off bound to one release SHA.

## References

[1]: https://hyperledger-fabric.readthedocs.io/en/latest/gateway.html "Hyperledger Fabric Gateway"
[2]: https://hyperledger-fabric.readthedocs.io/en/latest/sdk_chaincode.html "Hyperledger Fabric Contract and Application APIs"
[3]: https://hyperledger-fabric.readthedocs.io/en/latest/private-data/private-data.html "Hyperledger Fabric Private Data"
