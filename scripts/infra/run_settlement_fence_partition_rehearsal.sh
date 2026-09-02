#!/usr/bin/env bash
set -Eeuo pipefail

# Settlement-fence partition rehearsal.
# This is an integration rehearsal, not a substitute for a real HA PostgreSQL
# or network-partition lab. It requires Docker and the repository Go toolchain.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ENGINE="$ROOT/services/payment-engine"
CONTAINER="umoja-fence-partition-${RANDOM}-${RANDOM}"
DB_NAME=umoja_test
DB_USER=umoja_app
DB_PASSWORD=partition-test-password
DB_PORT="${UMOJA_FENCE_PARTITION_PORT:-55440}"
DSN="postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_NAME}?sslmode=disable"

command -v docker >/dev/null 2>&1 || { echo "SKIP: Docker is required" >&2; exit 77; }
cleanup() { docker unpause "$CONTAINER" >/dev/null 2>&1 || true; docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

mkdir -p "$ROOT/artifacts/settlement-fence"
docker run -d --name "$CONTAINER" \
  -e POSTGRES_DB="$DB_NAME" \
  -e POSTGRES_USER="$DB_USER" \
  -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  -p "${DB_PORT}:5432" \
  postgres:16-alpine >/dev/null

for attempt in $(seq 1 60); do
  if docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then break; fi
  [[ "$attempt" == 60 ]] && { echo "database did not become ready" >&2; exit 1; }
  sleep 1
done

docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$ROOT/database/postgresql/0059_settlement_fence_commands.sql"

export UMOJA_FENCE_TEST_DATABASE_URL="$DSN"
export PATH="$ROOT/.toolchain/go/bin:$ENGINE/.toolchain/go/bin:$PATH"
cd "$ENGINE"

go test ./internal/fencestore -count=1 -race -v | tee "$ROOT/artifacts/settlement-fence/partition-before.log"

# Simulate loss of the authoritative database connection. The safe expected
# behavior is that the application cannot persist a new command and therefore
# retains the existing fence; this script does not attempt to reopen it.
docker pause "$CONTAINER" >/dev/null
if go test ./internal/fencestore -run '^TestPostgresFenceStoreReplayIdempotencyAndConflict$' -count=1 >/dev/null 2>&1; then
  echo "FAIL: database writes unexpectedly succeeded while authority was paused" >&2
  exit 1
else
  echo "PASS: database writes unavailable while authority was paused"
fi

docker unpause "$CONTAINER" >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then break; fi
  [[ "$attempt" == 30 ]] && { echo "database did not recover" >&2; exit 1; }
  sleep 1
done

go test ./internal/fencestore -count=1 -race -v | tee "$ROOT/artifacts/settlement-fence/partition-after.log"
echo "PASS: recovery tests completed; settlement must remain fenced until external HA authority and ledger evidence are verified"
