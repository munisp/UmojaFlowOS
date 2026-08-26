#!/usr/bin/env bash
# Validate retention circuit-breaker monitoring configuration without contacting
# Prometheus, Alertmanager, PagerDuty, or the engineering webhook.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROMTOOL_BIN="${PROMTOOL_BIN:-promtool}"
AMTOOL_BIN="${AMTOOL_BIN:-amtool}"
RULE_FILES=(
  "$ROOT/infra/retention-gateway/prometheus-production-circuit-alerts.yml"
  "$ROOT/infra/retention-gateway/prometheus-production-lockwait-alerts.yml"
)
ALERTMANAGER_FILE="$ROOT/infra/retention-gateway/alertmanager-production-pagerduty-lockwait.yml"

require_binary() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "required binary not found: $1" >&2
    exit 127
  }
}

require_binary "$PROMTOOL_BIN"
require_binary "$AMTOOL_BIN"

for rule in "${RULE_FILES[@]}"; do
  echo "Checking Prometheus rule syntax: $rule"
  "$PROMTOOL_BIN" check rules "$rule"
done

echo "Checking Alertmanager syntax: $ALERTMANAGER_FILE"
"$AMTOOL_BIN" check-config "$ALERTMANAGER_FILE"

assert_route() {
  local expected_receiver="$1"
  shift
  local output
  output="$("$AMTOOL_BIN" config routes test --config.file "$ALERTMANAGER_FILE" "$@")"
  printf '%s\n' "$output"
  if ! grep -Fqx "$expected_receiver" <<<"$output"; then
    echo "expected receiver '$expected_receiver' was not selected for: $*" >&2
    exit 1
  fi
}

circuit_labels=(
  'alertname=UmojaRetentionDatabaseCircuitOpenTransition'
  'service=retention-delete-worker'
  'environment=production'
  'urgency=page'
  'team=engineering'
)

# The circuit route deliberately continues, so both independent notification
# paths must match the same simulated alert.
assert_route pagerduty-retention-postgres-critical "${circuit_labels[@]}"
assert_route webhook-retention-engineering "${circuit_labels[@]}"

# The legacy lock-wait page must still route to PagerDuty.
assert_route pagerduty-retention-postgres-critical \
  'alertname=UmojaRetentionPostgresLockWaitProductionCritical' \
  'service=retention-delete-worker' \
  'environment=production' \
  'urgency=page'

echo "retention circuit alerting dry run: passed"
