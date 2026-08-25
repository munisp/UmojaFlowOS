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

if ! psql "$AUDIT_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v run_reference="$RUN_REFERENCE" \
  -v window_start="$WINDOW_START" \
  -v window_end="$WINDOW_END" \
  -v source_identity="$RECONCILIATION_SOURCE_IDENTITY" \
  -f "$(dirname "$0")/reconcile_tigerbeetle_postgres.sql"; then
  echo "reconciliation_status=indeterminate" >&2
  exit 1
fi

status=$(psql "$AUDIT_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 \
  -v run_reference="$RUN_REFERENCE" \
  -c "SELECT status FROM ledger_reconciliation_runs WHERE run_reference = '$RUN_REFERENCE'" \
  | tail -n 1)

case "$status" in
  reconciled)
    echo "reconciliation_status=reconciled"
    ;;
  discrepancy)
    echo "reconciliation_status=discrepancy" >&2
    exit 1
    ;;
  *)
    echo "reconciliation_status=indeterminate" >&2
    exit 1
    ;;
esac
