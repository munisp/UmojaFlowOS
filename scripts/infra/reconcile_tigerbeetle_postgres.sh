#!/usr/bin/env bash
set -euo pipefail

: "${AUDIT_DATABASE_URL:?set private TLS PostgreSQL URL in AUDIT_DATABASE_URL}"
: "${RECONCILIATION_SOURCE_IDENTITY:?set approved source identity}"

if [[ "${AUDIT_DATABASE_URL}" != *"sslmode=verify-full"* ]]; then
  [[ "${RECONCILIATION_ALLOW_INSECURE_LOOPBACK:-false}" == "true" ]] || {
    echo "AUDIT_DATABASE_URL must require sslmode=verify-full" >&2
    exit 2
  }
  [[ "${AUDIT_DATABASE_URL}" == postgresql:///*\?*sslmode=disable* || "${AUDIT_DATABASE_URL}" == postgresql://localhost* || "${AUDIT_DATABASE_URL}" == postgresql://127.0.0.1* ]] || {
    echo "insecure reconciliation override is restricted to loopback PostgreSQL" >&2
    exit 2
  }
fi

WINDOW_END=${WINDOW_END:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}
WINDOW_START=${WINDOW_START:-$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)}
RUN_REFERENCE=${RUN_REFERENCE:-tigerbeetle-reconciliation-$(date -u +%Y%m%dT%H%M%SZ)-$$}

write_metrics() {
  local status="$1"
  local discrepancy_count="${2:-0}"
  local timestamp
  timestamp=$(date +%s)
  if [[ -n "${RECONCILIATION_METRICS_PATH:-}" ]]; then
    local parent tmp
    parent=$(dirname "$RECONCILIATION_METRICS_PATH")
    mkdir -p "$parent"
    tmp="${RECONCILIATION_METRICS_PATH}.tmp.$$"
    cat > "$tmp" <<EOF
# HELP umoja_ledger_reconciliation_last_run_status Last reconciliation status, one-hot by status.
# TYPE umoja_ledger_reconciliation_last_run_status gauge
umoja_ledger_reconciliation_last_run_status{status="reconciled"} $([[ "$status" == "reconciled" ]] && echo 1 || echo 0)
umoja_ledger_reconciliation_last_run_status{status="discrepancy"} $([[ "$status" == "discrepancy" ]] && echo 1 || echo 0)
umoja_ledger_reconciliation_last_run_status{status="indeterminate"} $([[ "$status" == "indeterminate" ]] && echo 1 || echo 0)
# HELP umoja_ledger_reconciliation_last_discrepancy_count Discrepancies in the last reconciliation run.
# TYPE umoja_ledger_reconciliation_last_discrepancy_count gauge
umoja_ledger_reconciliation_last_discrepancy_count $discrepancy_count
# HELP umoja_ledger_reconciliation_last_run_timestamp_seconds Unix timestamp of the last reconciliation attempt.
# TYPE umoja_ledger_reconciliation_last_run_timestamp_seconds gauge
umoja_ledger_reconciliation_last_run_timestamp_seconds $timestamp
EOF
    chmod 0640 "$tmp"
    mv -f "$tmp" "$RECONCILIATION_METRICS_PATH"
  fi
}

if ! psql "$AUDIT_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v run_reference="$RUN_REFERENCE" \
  -v window_start="$WINDOW_START" \
  -v window_end="$WINDOW_END" \
  -v source_identity="$RECONCILIATION_SOURCE_IDENTITY" \
  -f "$(dirname "$0")/reconcile_tigerbeetle_postgres.sql"; then
  write_metrics indeterminate 0
  echo "reconciliation_status=indeterminate" >&2
  exit 1
fi

status=$(psql "$AUDIT_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 \
  -v run_reference="$RUN_REFERENCE" \
  -c "SELECT status FROM ledger_reconciliation_runs WHERE run_reference = :'run_reference'" \
  | tail -n 1)

case "$status" in
  reconciled)
    discrepancy_count=$(psql "$AUDIT_DATABASE_URL" -X -At -v run_reference="$RUN_REFERENCE" -c "SELECT discrepancy_count FROM ledger_reconciliation_runs WHERE run_reference = :'run_reference'" | tail -n 1)
    write_metrics reconciled "${discrepancy_count:-0}"
    echo "reconciliation_status=reconciled"
    ;;
  discrepancy)
    discrepancy_count=$(psql "$AUDIT_DATABASE_URL" -X -At -v run_reference="$RUN_REFERENCE" -c "SELECT discrepancy_count FROM ledger_reconciliation_runs WHERE run_reference = :'run_reference'" | tail -n 1)
    write_metrics discrepancy "${discrepancy_count:-0}"
    echo "reconciliation_status=discrepancy" >&2
    exit 1
    ;;
  *)
    write_metrics indeterminate 0
    echo "reconciliation_status=indeterminate" >&2
    exit 1
    ;;
esac
