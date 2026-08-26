#!/usr/bin/env sh
set -eu

: "${RETENTION_GATEWAY_DATABASE_URL:?required for fixture registration}"
: "${RETENTION_GATEWAY_HMAC_SECRET_FILE:?required for fixture token signing}"
: "${RETENTION_WORKER_BEARER_TOKEN:?required for worker API authentication}"
: "${LOCUST_HOST:?required worker endpoint}"

PROFILE="${LOADTEST_PROFILE:-unique}"
case "$PROFILE" in
  unique|contention) ;;
  *) echo "LOADTEST_PROFILE must be unique or contention" >&2; exit 64 ;;
esac

export RETENTION_WORKER_LOADTEST_FIXTURE=/work/retention-worker-lock-fixture.json
export LOCUST_SCENARIO="$PROFILE"
export LOCUST_PROMETHEUS_PORT="${LOCUST_PROMETHEUS_PORT:-9646}"
COUNT="${LOCUST_FIXTURE_COUNT:-10000}"
USERS="${LOCUST_USERS:-100}"
SPAWN_RATE="${LOCUST_SPAWN_RATE:-20}"
RUN_TIME="${LOCUST_RUN_TIME:-5m}"

cleanup() {
  rm -f "$RETENTION_WORKER_LOADTEST_FIXTURE"
}
trap cleanup EXIT INT TERM

python3 /app/scripts/infra/prepare_retention_worker_lock_loadtest.py \
  --count "$COUNT" \
  --ttl-minutes 20 \
  --output "$RETENTION_WORKER_LOADTEST_FIXTURE"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
exec locust -f /app/tests/load/locust_retention_worker.py \
  --host "$LOCUST_HOST" \
  --headless \
  --users "$USERS" \
  --spawn-rate "$SPAWN_RATE" \
  --run-time "$RUN_TIME" \
  --csv "/work/retention-lock-$PROFILE-$STAMP"
