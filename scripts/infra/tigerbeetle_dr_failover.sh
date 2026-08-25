#!/usr/bin/env bash
set -euo pipefail

# Fail-closed DR orchestration. Default mode is plan; no cluster mutation occurs
# unless the operator explicitly selects execute and supplies reviewed hooks.
MODE=${1:-plan}
EVIDENCE_DIR=${EVIDENCE_DIR:-/var/lib/umoja/dr-evidence}
STATE_FILE="$EVIDENCE_DIR/tigerbeetle-dr-state.json"
mkdir -p "$EVIDENCE_DIR"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$EVIDENCE_DIR/tigerbeetle-dr.log"; }
write_metrics() {
  local state="$1" path="${TIGERBEETLE_DR_METRICS_PATH:-}"
  [[ -n "$path" ]] || return 0
  mkdir -p "$(dirname "$path")"
  local tmp="${path}.tmp.$$" ts
  ts=$(date +%s)
  cat > "$tmp" <<EOF
# HELP umoja_tigerbeetle_failover_state Current failover state, one-hot by state.
# TYPE umoja_tigerbeetle_failover_state gauge
umoja_tigerbeetle_failover_state{state="indeterminate"} $([[ "$state" == "indeterminate" ]] && echo 1 || echo 0)
umoja_tigerbeetle_failover_state{state="resumed"} $([[ "$state" == "resumed" ]] && echo 1 || echo 0)
# HELP umoja_tigerbeetle_failover_last_event_timestamp_seconds Last failover state change timestamp.
# TYPE umoja_tigerbeetle_failover_last_event_timestamp_seconds gauge
umoja_tigerbeetle_failover_last_event_timestamp_seconds $ts
EOF
  chmod 0640 "$tmp"
  mv -f "$tmp" "$path"
}
fail() { write_metrics indeterminate; log "DR_FAILURE $*" >&2; exit 1; }
run_hook() {
  local name="$1" command_value="${2:-}"
  [[ -n "$command_value" ]] || fail "$name hook is required in execute mode"
  log "HOOK_START name=$name"
  bash -c "$command_value"
  log "HOOK_OK name=$name"
}

case "$MODE" in plan|execute) ;; *) echo "usage: $0 [plan|execute]" >&2; exit 64 ;; esac
if [[ "$MODE" == execute ]]; then
  write_metrics indeterminate
fi

cat > "$STATE_FILE" <<EOF
{"event":"tigerbeetle_dr_started","mode":"$MODE","started_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","transactions_frozen":false,"old_primary_fenced":false,"new_primary_verified":false,"reconciled":false}
EOF
chmod 0640 "$STATE_FILE"

log "STEP_1 freeze new transaction submissions and mark in-flight calls indeterminate"
if [[ "$MODE" == execute ]]; then
  [[ "${CONFIRM_DR_FAILOVER:-}" == "APPROVED-TIGERBEETLE-FAILOVER" ]] || fail "set CONFIRM_DR_FAILOVER=APPROVED-TIGERBEETLE-FAILOVER in an approved window"
  run_hook freeze "${FREEZE_TRANSACTIONS_COMMAND:-}"
fi

log "STEP_2 fence the old primary; do not promote while it can accept writes"
if [[ "$MODE" == execute ]]; then
  run_hook fence "${FENCE_OLD_PRIMARY_COMMAND:-}"
fi

log "STEP_3 verify quorum, cluster identity, replica format, and last durable commit"
if [[ "$MODE" == execute ]]; then
  run_hook verify_quorum "${VERIFY_NEW_PRIMARY_COMMAND:-}"
fi

log "STEP_4 promote exactly one authoritative writer"
if [[ "$MODE" == execute ]]; then
  run_hook promote "${PROMOTE_NEW_PRIMARY_COMMAND:-}"
fi

log "STEP_5 reconcile every in-flight intent using the original deterministic transfer ID"
if [[ "$MODE" == execute ]]; then
  run_hook reconcile "${RECONCILE_INFLIGHT_COMMAND:-}"
fi

log "STEP_6 run PostgreSQL/TigerBeetle reconciliation before resuming traffic"
if [[ "$MODE" == execute ]]; then
  run_hook ledger_reconciliation "${LEDGER_RECONCILIATION_COMMAND:-}"
fi

log "STEP_7 resume only after quorum, fencing, reconciliation, and evidence checks pass"
if [[ "$MODE" == execute ]]; then
  run_hook resume "${RESUME_TRANSACTIONS_COMMAND:-}"
  write_metrics resumed
fi

if [[ "$MODE" == plan ]]; then
  log "PLAN_ONLY no cluster, transaction, or database mutation performed"
else
  log "DR_SUCCESS operator hooks completed; retain evidence before closing incident"
fi
