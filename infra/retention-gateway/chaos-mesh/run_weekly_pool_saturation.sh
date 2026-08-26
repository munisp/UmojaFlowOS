#!/usr/bin/env sh
set -eu

: "${RETENTION_GATEWAY_DATABASE_URL:?required}"
: "${RETENTION_GATEWAY_HMAC_SECRET_FILE:?required}"
: "${WORKER_SERVICE_URL:?required}"
: "${WORKER_BEARER_TOKEN:?required}"
: "${PROMETHEUS_URL:?required}"
: "${PROMETHEUS_BEARER_TOKEN_FILE:?required}"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
# Retain report directories for 90 days; only this fixed prefix is eligible for cleanup.
find /work -mindepth 1 -maxdepth 1 -type d -name 'chaos-pool-saturation-*' -mtime +90 -exec rm -rf {} +
RUN_DIR="/work/chaos-pool-saturation-${STAMP}"
mkdir -p "$RUN_DIR"
FIXTURE="$RUN_DIR/fixture.json"
JUNIT="$RUN_DIR/junit.xml"

cleanup() {
  rm -f "$FIXTURE"
}
trap cleanup EXIT INT TERM

python3 /app/scripts/infra/prepare_retention_worker_lock_loadtest.py \
  --count "${CHAOS_POOL_PAYLOAD_COUNT:-20}" \
  --ttl-minutes 20 \
  --output "$FIXTURE"

export RUN_CHAOS_MESH=1
export CHAOS_USE_SCHEDULED_POOL_FAULT=1
export WORKER_POOL_SATURATION_PAYLOADS_FILE="$FIXTURE"

set +e
pytest -m chaos -q \
  /app/tests/chaos_mesh/test_retention_worker_chaos.py \
  -k postgres_connection_pool_saturation \
  --junitxml "$JUNIT"
TEST_EXIT=$?
set -e

set +e
python3 /app/scripts/infra/report_retention_pool_saturation_chaos.py \
  --junit "$JUNIT" \
  --output-dir "$RUN_DIR"
REPORT_EXIT=$?
set -e

if [ "$TEST_EXIT" -ne 0 ] || [ "$REPORT_EXIT" -ne 0 ]; then
  exit 1
fi
