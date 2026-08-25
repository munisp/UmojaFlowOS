#!/usr/bin/env bash
# Pre-production acceptance gate for UmojaFlowOS segregation-of-duties monitoring.
# This script never enables monitoring, creates an alert policy, mutates readiness
# evidence, or invokes an external provider. It fails closed if required evidence
# or an independent WORM verification command is unavailable.
set -euo pipefail

ROOT=${UMOJA_REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}
ROOT=$(cd "$ROOT" && pwd)
MODE=${1:-check}
if [[ "$MODE" != "check" && "$MODE" != "database" ]]; then
  echo "usage: $0 [check|database]" >&2
  exit 64
fi

require_file() {
  [[ -f "$1" ]] || { echo "missing required file: $1" >&2; exit 2; }
}
require_contains() {
  grep -Fq "$2" "$1" || { echo "required marker missing from $1: $2" >&2; exit 2; }
}

MIGRATION="$ROOT/database/postgresql/0041_segregation_of_duties_alerting.sql"
VALIDATOR="$ROOT/database/postgresql/validate_schema.sql"
MONITOR="$ROOT/apps/control-plane/server/segregationOfDutiesMonitor.ts"
AUDIT_LOG="$ROOT/apps/control-plane/server/segregationOfDutiesAuditLog.ts"
WAZUH_AGENT="$ROOT/infra/wazuh/umoja-sod-agent-ossec.conf.template"
WAZUH_RULES="$ROOT/infra/wazuh/umoja-sod-rules.xml.template"
WAZUH_OVERLAY="$ROOT/infra/security-stack/compose.wazuh-sod.yaml.template"

for file in "$MIGRATION" "$VALIDATOR" "$MONITOR" "$AUDIT_LOG" "$WAZUH_AGENT" "$WAZUH_RULES" "$WAZUH_OVERLAY"; do require_file "$file"; done
require_contains "$MIGRATION" "segregation_of_duties"
require_contains "$MIGRATION" "segregation_of_duties_evaluation_runs"
require_contains "$VALIDATOR" "segregation_of_duties_evaluation_runs"
require_contains "$MONITOR" "UMOJA_SOD_MONITOR_ENABLED"
require_contains "$MONITOR" "pg_try_advisory_lock"
require_contains "$MONITOR" "indeterminate"
require_contains "$AUDIT_LOG" "UMOJA_SOD_AUDIT_LOG_PATH"
require_contains "$WAZUH_AGENT" "sod-audit.jsonl"
require_contains "$WAZUH_RULES" "sod_monitor_indeterminate"
require_contains "$WAZUH_OVERLAY" "sod-audit:/var/log/umoja:ro"

echo "static_controls=passed"

if [[ "$MODE" == "database" ]]; then
  : "${AUDIT_DATABASE_URL:?set an auditor/read-only PostgreSQL URL}"
  : "${UMOJA_APP_DB_ROLE:?set the staging application database role name}"
  psql "$AUDIT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v app_role="$UMOJA_APP_DB_ROLE" \
    -f "$ROOT/scripts/infra/audit_sod_readiness_assurance_readonly.sql"
  echo "database_audit=passed"
fi

: "${WORM_VERIFY_SCRIPT:?set an absolute path to the independently administered WORM verifier script}"
[[ "$WORM_VERIFY_SCRIPT" = /* ]] || { echo "WORM_VERIFY_SCRIPT must be absolute" >&2; exit 2; }
[[ -x "$WORM_VERIFY_SCRIPT" ]] || { echo "WORM_VERIFY_SCRIPT must be executable" >&2; exit 2; }
"$WORM_VERIFY_SCRIPT"
echo "worm_verification=passed"

echo "sod_alerting_acceptance=passed"
