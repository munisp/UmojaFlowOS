#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: run_staging_e02_schema_gate.sh [--dry-run]

Default mode applies the canonical root PostgreSQL migration chain to the
explicitly approved staging database, then validates the migration ledger,
reconciliation columns, canonical schema, and required application grants.
The script never prints POSTGRES_DATABASE_URL and refuses to run without an
explicit staging approval marker.

Required environment:
  POSTGRES_DATABASE_URL
  STAGING_E02_APPROVED=STAGING_SCHEMA_MIGRATION
  STAGING_EVIDENCE_DIR
  RELEASE_SHA (40 lowercase hexadecimal characters)
USAGE
}

mode="apply"
case "${1:-}" in
  "") ;;
  --dry-run) mode="dry-run" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 64 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

: "${RELEASE_SHA:?RELEASE_SHA is required}"
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo "RELEASE_SHA must be a lowercase 40-character Git SHA" >&2; exit 64; }
: "${STAGING_EVIDENCE_DIR:?STAGING_EVIDENCE_DIR is required}"
: "${STAGING_E02_APPROVED:?STAGING_E02_APPROVED is required}"
[[ "$STAGING_E02_APPROVED" == "STAGING_SCHEMA_MIGRATION" ]] || {
  echo "refusing E-02: STAGING_E02_APPROVED must equal STAGING_SCHEMA_MIGRATION" >&2
  exit 77
}

mkdir -p "$STAGING_EVIDENCE_DIR"
printf 'release_sha=%s\nenvironment=staging\ncreated_at=%s\n' \
  "$RELEASE_SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$STAGING_EVIDENCE_DIR/e02-run-metadata.txt"

if [[ "$mode" == "dry-run" ]]; then
  scripts/infra/apply_postgres_migrations.sh --dry-run \
    > "$STAGING_EVIDENCE_DIR/e02-migration-inventory.txt"
  echo "E-02 dry-run inventory written to $STAGING_EVIDENCE_DIR/e02-migration-inventory.txt"
  exit 0
fi

: "${POSTGRES_DATABASE_URL:?POSTGRES_DATABASE_URL is required}"
command -v psql >/dev/null 2>&1 || { echo "psql is required" >&2; exit 69; }

scripts/infra/apply_postgres_migrations.sh \
  > "$STAGING_EVIDENCE_DIR/e02-migration-job.log" \
  2> "$STAGING_EVIDENCE_DIR/e02-migration-job.stderr.log"

psql "$POSTGRES_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 \
  -c "SELECT version, count(*) FROM schema_migrations GROUP BY version HAVING count(*) <> 1 ORDER BY version" \
  > "$STAGING_EVIDENCE_DIR/e02-duplicate-migrations.tsv"
[[ ! -s "$STAGING_EVIDENCE_DIR/e02-duplicate-migrations.tsv" ]] || {
  echo "E-02 failed: duplicate migration versions found" >&2
  exit 3
}

psql "$POSTGRES_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 \
  -c "SELECT version, state, checksum, applied_at FROM schema_migrations ORDER BY version" \
  > "$STAGING_EVIDENCE_DIR/e02-migration-ledger.tsv"

expected_count="$(find database/postgresql -maxdepth 1 -type f -name '00*.sql' | wc -l | tr -d ' ')"
actual_count="$(awk 'NF { count++ } END { print count + 0 }' "$STAGING_EVIDENCE_DIR/e02-migration-ledger.tsv")"
[[ "$actual_count" == "$expected_count" ]] || {
  echo "E-02 failed: expected $expected_count applied migrations, found $actual_count" >&2
  exit 4
}

psql "$POSTGRES_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f database/postgresql/validate_schema.sql \
  > "$STAGING_EVIDENCE_DIR/e02-schema-validation.log"

psql "$POSTGRES_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 \
  -c "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND ((table_name='ledger_reconciliation_runs' AND column_name IN ('status','run_reference')) OR (table_name='ledger_reconciliation_discrepancies' AND column_name IN ('discrepancy_code','expected_value','actual_value'))) ORDER BY table_name, column_name" \
  > "$STAGING_EVIDENCE_DIR/e02-reconciliation-columns.tsv"

psql "$POSTGRES_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 \
  -c "SELECT current_database(), current_user" \
  > "$STAGING_EVIDENCE_DIR/e02-database-identity.txt"

psql "$POSTGRES_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 \
  -c "SELECT has_table_privilege(current_user, 'ledger_reconciliation_runs', 'INSERT'), has_table_privilege(current_user, 'ledger_reconciliation_runs', 'UPDATE'), has_table_privilege(current_user, 'ledger_reconciliation_runs', 'DELETE'), has_table_privilege(current_user, 'ledger_reconciliation_discrepancies', 'DELETE')" \
  > "$STAGING_EVIDENCE_DIR/e02-application-privileges.tsv"

printf 'E-02 schema and reconciliation gate passed for release %s\n' "$RELEASE_SHA"
