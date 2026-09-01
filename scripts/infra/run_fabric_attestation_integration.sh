#!/usr/bin/env bash
set -Eeuo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
go_bin="${GO_BIN:-/home/ubuntu/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.25.4.linux-amd64/bin/go}"
if ! [[ -x "$go_bin" ]]; then
  go_bin="$(command -v go || true)"
fi
if [[ -z "$go_bin" || ! -x "$go_bin" ]]; then
  echo "go toolchain unavailable" >&2
  exit 1
fi

cd "$repo/services/payment-engine"
"$go_bin" test ./internal/attestation -race -count=1

chaincode_dir="$repo/integrations/hyperledger-fabric/consortium-attestation/chaincode-go"
if [[ -f "$chaincode_dir/go.mod" ]]; then
  cd "$chaincode_dir"
  "$go_bin" test ./... -race -count=1
fi

if [[ "${FABRIC_LIVE:-0}" == "1" ]]; then
  cd "$repo/services/payment-engine"
  FABRIC_LIVE=1 "$go_bin" test -tags fabric_integration ./internal/attestation -count=1
fi

if [[ "${FABRIC_LIVE_PARTITION:-0}" == "1" ]]; then
  : "${UMOJA_FABRIC_PARTITION_ENDPOINT:?set blackholed UMOJA_FABRIC_PARTITION_ENDPOINT}"
  cd "$repo/services/payment-engine"
  FABRIC_LIVE_PARTITION=1 "$go_bin" test -tags fabric_integration ./internal/attestation -run TestFabricLivePartitionFailsClosed -count=1
fi

echo "Fabric attestation integration suite completed"
