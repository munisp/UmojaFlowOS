#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: apply_postgres_migrations.sh [--dry-run]

Applies the canonical root database/postgresql/000*.sql migration chain against
POSTGRES_DATABASE_URL. The runner holds a PostgreSQL advisory lock for the full
session, writes an auditable version/checksum/state ledger, rejects changed
migration content, and refuses to continue after an interrupted migration.
USAGE
}

mode="apply"
case "${1:-}" in
  "") ;;
  --dry-run) mode="dry-run" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 64 ;;
esac

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
migrations_dir="$root_dir/database/postgresql"
mapfile -t migrations < <(find "$migrations_dir" -maxdepth 1 -type f -name '00*.sql' -printf '%f\n' | LC_ALL=C sort)

if [[ ${#migrations[@]} -eq 0 ]]; then
  echo "no canonical migrations found under $migrations_dir" >&2
  exit 65
fi

for migration in "${migrations[@]}"; do
  [[ "$migration" =~ ^[0-9]{4}_[A-Za-z0-9_]+\.sql$ ]] || {
    echo "unsafe canonical migration name: $migration" >&2
    exit 65
  }
done

if [[ "$mode" == "dry-run" ]]; then
  printf 'canonical_migration_dir=%s\n' "$migrations_dir"
  for migration in "${migrations[@]}"; do
    printf '%s  %s\n' "$(sha256sum "$migrations_dir/$migration" | awk '{print $1}')" "$migration"
  done
  exit 0
fi

: "${POSTGRES_DATABASE_URL:?POSTGRES_DATABASE_URL is required}"

command -v psql >/dev/null 2>&1 || {
  echo "psql is required" >&2
  exit 69
}

session_file="$(mktemp)"
trap 'rm -f "$session_file"' EXIT

cat >"$session_file" <<'SQL'
\set ON_ERROR_STOP on
SELECT pg_advisory_lock(738201049128773);
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  checksum CHAR(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('started', 'applied')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ
);
SQL

for migration in "${migrations[@]}"; do
  version="${migration%%_*}"
  checksum="$(sha256sum "$migrations_dir/$migration" | awk '{print $1}')"
  absolute_path="$migrations_dir/$migration"
  cat >>"$session_file" <<SQL
DO \$migration_guard\$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version = '$version'
       AND (checksum <> '$checksum' OR state <> 'applied')
  ) THEN
    RAISE EXCEPTION 'migration % has changed or was interrupted; investigate before retrying', '$version';
  END IF;
END
\$migration_guard\$;
SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = '$version' AND state = 'applied') AS already_applied \gset
\if :already_applied
\echo migration $version already applied and checksum verified
\else
INSERT INTO schema_migrations (version, checksum, state) VALUES ('$version', '$checksum', 'started');
\i '$absolute_path'
UPDATE schema_migrations SET state = 'applied', applied_at = now() WHERE version = '$version' AND checksum = '$checksum' AND state = 'started';
\echo migration $version applied
\endif
SQL
done

cat >>"$session_file" <<'SQL'
SELECT pg_advisory_unlock(738201049128773);
SQL

psql "$POSTGRES_DATABASE_URL" -X -f "$session_file"
