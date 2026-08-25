#!/usr/bin/env bash
# Staging runner for forward-only migration 0041.
# Default mode is read-only. The script never enables the SoD monitor or an alert policy.
set -euo pipefail

MODE=${1:-check}
if [[ "$MODE" != "check" && "$MODE" != "--apply" ]]; then
  echo "usage: $0 [check|--apply]" >&2
  exit 64
fi

: "${UMOJA_REPO_ROOT:?set reviewed UmojaFlowOS main checkout}"
: "${STAGING_DATABASE_URL:?set schema-owner staging PostgreSQL connection URL}"
: "${UMOJA_STAGING_APP_DB_ROLE:?set staging application database role name}"

ROOT=$(cd "$UMOJA_REPO_ROOT" && pwd)
MIGRATION="$ROOT/database/postgresql/0041_segregation_of_duties_alerting.sql"
VALIDATOR="$ROOT/database/postgresql/validate_schema.sql"
GRANTS="$ROOT/database/postgresql/grants.sql"
for file in "$MIGRATION" "$VALIDATOR" "$GRANTS"; do
  [[ -f "$file" ]] || { echo "missing required file: $file" >&2; exit 2; }
done

state=$(psql "$STAGING_DATABASE_URL" -X -Atv ON_ERROR_STOP=1 <<'SQL'
SELECT CASE
  WHEN to_regclass('public.segregation_of_duties_evaluation_runs') IS NULL
   AND to_regtype('public.segregation_of_duties_evaluation_state') IS NULL THEN 'absent'
  WHEN to_regclass('public.segregation_of_duties_evaluation_runs') IS NOT NULL
   AND to_regtype('public.segregation_of_duties_evaluation_state') IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.alert_policies'::regclass
       AND pg_get_constraintdef(c.oid, true) LIKE '%segregation_of_duties%'
   )
   AND EXISTS (
     SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.compliance_alerts'::regclass
       AND pg_get_constraintdef(c.oid, true) LIKE '%segregation_of_duties%'
   ) THEN 'present'
  ELSE 'partial'
END;
SQL
)
printf 'migration_0041_state=%s\n' "$state"

case "$state" in
  absent) ;;
  present) echo "migration 0041 already present; no DDL will run" ;;
  partial)
    echo "partial 0041 schema detected; stop and obtain a reviewed forward-only remediation" >&2
    exit 3
    ;;
  *) echo "unexpected migration state: $state" >&2; exit 2 ;;
esac

if [[ "$MODE" == "check" ]]; then
  echo "dry_run=complete; no migration, grant, policy, monitor, provider, or notification action was performed"
  exit 0
fi

[[ "${CONFIRM_STAGING_SCHEMA_CHANGE:-}" == "APPLY-0041-SOD" ]] || {
  echo "refusing DDL: set CONFIRM_STAGING_SCHEMA_CHANGE=APPLY-0041-SOD only in an approved change window" >&2
  exit 4
}

if [[ "$state" == "absent" ]]; then
  psql "$STAGING_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$MIGRATION"
fi
psql "$STAGING_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v app_role="$UMOJA_STAGING_APP_DB_ROLE" -f "$GRANTS"
psql "$STAGING_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$VALIDATOR"

echo "migration_0041=validated"
echo "postcondition: SoD monitor and alert policies remain disabled until separately approved deployment configuration enables them"
