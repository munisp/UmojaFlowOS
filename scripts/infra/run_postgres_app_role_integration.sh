#!/usr/bin/env bash
# Execute the counterparty onboarding PostgreSQL integration gate against a
# disposable local database. This script is deliberately local-only: it uses
# the host PostgreSQL superuser through peer-authenticated sudo and refuses to
# operate on a database name outside the assurance prefix.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
ENVIRONMENT=${UMOJA_ASSURANCE_ENV:-local_assurance}
DATABASE_NAME=${UMOJA_ASSURANCE_DATABASE:-umojaflowos_assurance_app_role}
SCHEMA_OWNER_ROLE=${UMOJA_ASSURANCE_SCHEMA_OWNER_ROLE:-assurance_schema_owner}
APPLICATION_ROLE=${UMOJA_ASSURANCE_APPLICATION_ROLE:-assurance_application}
LOG_FILE=${UMOJA_ASSURANCE_LOG_FILE:-"$ROOT_DIR/assurance/evidence/postgres_app_role_integration.log"}

if [[ "$ENVIRONMENT" != "local_assurance" ]]; then
  echo "Refusing to run outside UMOJA_ASSURANCE_ENV=local_assurance" >&2
  exit 64
fi
if [[ ! "$DATABASE_NAME" =~ ^umojaflowos_assurance_[a-z0-9_]+$ ]]; then
  echo "Refusing unsafe disposable database name: $DATABASE_NAME" >&2
  exit 64
fi
if [[ ! "$SCHEMA_OWNER_ROLE" =~ ^[a-z_][a-z0-9_]*$ ]] || [[ ! "$APPLICATION_ROLE" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "Refusing unsafe PostgreSQL role name" >&2
  exit 64
fi
if [[ "$SCHEMA_OWNER_ROLE" == "$APPLICATION_ROLE" ]]; then
  echo "Schema-owner and application roles must be distinct" >&2
  exit 64
fi
for command in sudo psql createdb dropdb openssl pnpm; do
  command -v "$command" >/dev/null || { echo "Missing required command: $command" >&2; exit 69; }
done

mkdir -p "$(dirname "$LOG_FILE")"
: > "$LOG_FILE"
OWNER_PASSWORD=$(openssl rand -hex 24)
APPLICATION_PASSWORD=$(openssl rand -hex 24)
OWNER_URL="postgresql://${SCHEMA_OWNER_ROLE}:${OWNER_PASSWORD}@127.0.0.1:5432/${DATABASE_NAME}"
APPLICATION_URL="postgresql://${APPLICATION_ROLE}:${APPLICATION_PASSWORD}@127.0.0.1:5432/${DATABASE_NAME}"

cleanup() {
  sudo -u postgres dropdb --if-exists "$DATABASE_NAME" >>"$LOG_FILE" 2>&1 || true
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS $APPLICATION_ROLE" >>"$LOG_FILE" 2>&1 || true
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS $SCHEMA_OWNER_ROLE" >>"$LOG_FILE" 2>&1 || true
}
trap cleanup EXIT

sudo -u postgres dropdb --if-exists "$DATABASE_NAME" >>"$LOG_FILE" 2>&1
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS $APPLICATION_ROLE" >>"$LOG_FILE" 2>&1
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "DROP ROLE IF EXISTS $SCHEMA_OWNER_ROLE" >>"$LOG_FILE" 2>&1
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE $SCHEMA_OWNER_ROLE LOGIN PASSWORD '$OWNER_PASSWORD'" >>"$LOG_FILE" 2>&1
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE $APPLICATION_ROLE LOGIN PASSWORD '$APPLICATION_PASSWORD'" >>"$LOG_FILE" 2>&1
sudo -u postgres createdb -O "$SCHEMA_OWNER_ROLE" "$DATABASE_NAME" >>"$LOG_FILE" 2>&1

while IFS= read -r migration; do
  PGPASSWORD="$OWNER_PASSWORD" psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f "$migration" >>"$LOG_FILE" 2>&1
done < <(find "$ROOT_DIR/database/postgresql" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' -print | sort)

PGPASSWORD="$OWNER_PASSWORD" psql "$OWNER_URL" -v ON_ERROR_STOP=1 -v app_role="$APPLICATION_ROLE" -f "$ROOT_DIR/database/postgresql/grants.sql" >>"$LOG_FILE" 2>&1

(
  cd "$ROOT_DIR/apps/control-plane"
  POSTGRES_INTEGRATION_TEST=1 \
  POSTGRES_DATABASE_URL="$APPLICATION_URL" \
  POSTGRES_TEST_SCHEMA_OWNER_DATABASE_URL="$OWNER_URL" \
  pnpm exec vitest run server/counterpartyOnboarding.integration.test.ts
) >>"$LOG_FILE" 2>&1

echo "PostgreSQL application-role integration passed; evidence: $LOG_FILE"
