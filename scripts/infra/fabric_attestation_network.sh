#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'USAGE'
Usage: fabric_attestation_network.sh {up|deploy|smoke|down}

Required:
  FABRIC_SAMPLES_DIR  Path to the official hyperledger/fabric-samples checkout.
Optional:
  FABRIC_CHANNEL      Channel name (default: umoja-channel)
  FABRIC_CHAINCODE    Chaincode name (default: consortium-attestation)
  FABRIC_CHAINCODE_VERSION (default: 1.0)
USAGE
}

command -v docker >/dev/null 2>&1 || { echo 'docker is required' >&2; exit 69; }
SAMPLES=${FABRIC_SAMPLES_DIR:?FABRIC_SAMPLES_DIR must point to hyperledger/fabric-samples}
NETWORK="$SAMPLES/test-network"
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
CHAINCODE="$ROOT_DIR/integrations/hyperledger-fabric/consortium-attestation/chaincode-go"
CHANNEL=${FABRIC_CHANNEL:-umoja-channel}
CHAINCODE_NAME=${FABRIC_CHAINCODE:-consortium-attestation}
VERSION=${FABRIC_CHAINCODE_VERSION:-1.0}
[[ -d "$NETWORK" && -x "$NETWORK/network.sh" ]] || { echo "invalid Fabric samples test-network: $NETWORK" >&2; exit 64; }
[[ -f "$CHAINCODE/go.mod" ]] || { echo "chaincode module missing: $CHAINCODE" >&2; exit 65; }
export PATH="$SAMPLES/bin:$PATH"
export FABRIC_CFG_PATH="$SAMPLES/config"

case "${1:-}" in
  up)
    cd "$NETWORK"
    ./network.sh down
    ./network.sh up createChannel -ca -c "$CHANNEL"
    ;;
  deploy)
    cd "$NETWORK"
    ./network.sh deployCC -ccn "$CHAINCODE_NAME" -ccp "$CHAINCODE" -ccl go -ccv "$VERSION" -c "$CHANNEL"
    ;;
  smoke)
    command -v peer >/dev/null 2>&1 || { echo 'peer binary is required for smoke test' >&2; exit 69; }
    cd "$NETWORK"
    export CORE_PEER_TLS_ENABLED=true
    export CORE_PEER_LOCALMSPID=Org1MSP
    export CORE_PEER_TLS_ROOTCERT_FILE="$SAMPLES/test-network/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
    export CORE_PEER_MSPCONFIGPATH="$SAMPLES/test-network/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
    export CORE_PEER_ADDRESS=localhost:7051
    release_sha=${FABRIC_SMOKE_RELEASE_SHA:-0123456789abcdef0123456789abcdef01234567}
    evidence_sha=${FABRIC_SMOKE_EVIDENCE_SHA256:-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}
    peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com --tls --cafile "$SAMPLES/test-network/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem" -C "$CHANNEL" -n "$CHAINCODE_NAME" --peerAddresses localhost:7051 --tlsRootCertFiles "$CORE_PEER_TLS_ROOTCERT_FILE" -c "{\"function\":\"CreateAttestation\",\"Args\":[\"$release_sha\",\"E-09\",\"$evidence_sha\",\"evidence/E-09.json\",\"Org1MSP-Org2MSP\"]}" --waitForEvent
    peer chaincode query -C "$CHANNEL" -n "$CHAINCODE_NAME" -c "{\"function\":\"VerifyDigest\",\"Args\":[\"$(printf '%s' "$release_sha" | sha256sum | cut -c1-64)\",\"$evidence_sha\"]}" || true
    ;;
  down)
    cd "$NETWORK"; ./network.sh down
    ;;
  *) usage >&2; exit 64;;
esac
