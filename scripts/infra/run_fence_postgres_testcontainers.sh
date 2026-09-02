#!/usr/bin/env bash
set -Eeuo pipefail

# Ephemeral PostgreSQL runner for the fence-store integration suite.
# Requires Docker or Podman and the repository-pinned Go toolchain.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ENGINE="$ROOT/services/payment-engine"
DB_CONTAINER="umoja-fence-postgres-${RANDOM}-${RANDOM}"
DB_NAME="umoja_test"
DB_USER="umoja_app"
DB_PASSWORD="integration-only-password"
DB_PORT="${UMOJA_FENCE_TEST_DB_PORT:-55439}"
DB_DSN="postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${DB_PORT}/${DB_NAME}?sslmode=disable"
RUNTIME="${CONTAINER_RUNTIME:-docker}"

if ! command -v "$RUNTIME" >/dev/null 2>&1; then
  echo "SKIP: $RUNTIME is not installed; install Docker/Podman to run the ephemeral PostgreSQL suite" >&2
  exit 77
fi

cleanup() {
  "$RUNTIME" rm -f "$DB_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

"$RUNTIME" run -d --name "$DB_CONTAINER" \
  -e POSTGRES_DB="$DB_NAME" \
  -e POSTGRES_USER="$DB_USER" \
  -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  -p "${DB_PORT}:5432" \
  postgres:16-alpine >/dev/null

for attempt in $(seq 1 60); do
  if "$RUNTIME" exec "$DB_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
    break
  fi
  if [[ "$attempt" == 60 ]]; then
    echo "PostgreSQL did not become ready" >&2
    exit 1
  fi
  sleep 1
done

"$RUNTIME" exec -i "$DB_CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" < "$ROOT/database/postgresql/0059_settlement_fence_commands.sql"

export UMOJA_FENCE_TEST_DATABASE_URL="$DB_DSN"
export PATH="$ENGINE/.toolchain/go/bin:$ROOT/.toolchain/go/bin:$PATH"
cd "$ENGINE"

go test ./internal/fencestore -count=1 -race -v
go test ./internal/reconciliation ./internal/observability -count=1 -race

go test ./internal/fencestore -run '^$' -bench BenchmarkPostgresFenceStoreConcurrentSequence \
  -benchmem -benchtime="${FENCE_BENCH_TIME:-10s}" -count="${FENCE_BENCH_COUNT:-3}" \
  | tee "$ROOT/artifacts/fence-store-benchmark.txt"
