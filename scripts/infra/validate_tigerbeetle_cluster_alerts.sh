#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RULE_FILE="${ROOT_DIR}/infra/monitoring/umoja-tigerbeetle-cluster-alerts.yml"
TEST_FILE="${ROOT_DIR}/infra/monitoring/umoja-tigerbeetle-cluster-alerts.test.yml"

command -v promtool >/dev/null 2>&1 || {
  echo "promtool is required; install the pinned monitoring toolchain first" >&2
  exit 2
}

promtool check rules "${RULE_FILE}"
for alert in \
  UmojaTigerBeetleQuorumLost \
  UmojaTigerBeetleNodeViewDivergence \
  UmojaTigerBeetleConsensusErrors \
  UmojaTigerBeetleClusterIdentityMismatch \
  UmojaTigerBeetleUnsafeWriteFence \
  UmojaTigerBeetleUnknownTransfersGrowing \
  UmojaTigerBeetleReconciliationMismatch \
  UmojaTigerBeetleClusterTelemetryAbsent \
  UmojaTigerBeetleRecoveryViewNotConverged \
  UmojaTigerBeetleRecoveryReconciliationPending; do
  grep -q "alert: ${alert}$" "${RULE_FILE}" || {
    echo "required alert missing: ${alert}" >&2
    exit 1
  }
done
promtool test rules "${TEST_FILE}"
echo "TigerBeetle cluster alert validation: PASS"
