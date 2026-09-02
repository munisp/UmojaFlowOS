#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="$ROOT_DIR/artifacts/full-test-matrix"
mkdir -p "$ARTIFACT_DIR"
export PATH="$ROOT_DIR/.toolchain/bin:$HOME/.cargo/bin:$PATH"
if [[ -f /home/ubuntu/.umoja_local_test_db.env ]]; then
  set -a
  . /home/ubuntu/.umoja_local_test_db.env
  set +a
fi

run_case() {
  local name="$1"; shift
  local log="$ARTIFACT_DIR/${name}.log"
  local timing="$ARTIFACT_DIR/${name}.timing"
  local started_ns ended_ns elapsed_ns
  started_ns="$(date +%s%N)"
  set +e
  "$@" >"$log" 2>&1
  local status=$?
  set -e
  ended_ns="$(date +%s%N)"
  elapsed_ns=$((ended_ns - started_ns))
  printf 'elapsed_seconds=%.3f\nexit_status=%s\n' "$((elapsed_ns / 1000000))e-3" "$status" > "$timing"
  printf '%s|%s|%s\n' "$name" "$status" "$(tr '\n' ';' < "$timing")" | tee -a "$ARTIFACT_DIR/summary.tsv"
  return 0
}

: > "$ARTIFACT_DIR/summary.tsv"
run_case go_test_race bash -lc 'cd "$1/services/payment-engine" && go test -race -covermode=atomic -coverprofile="$2/go.coverprofile" ./...' _ "$ROOT_DIR" "$ARTIFACT_DIR"
run_case rust_risk_test bash -lc 'cd "$1/services/risk-compliance-core" && cargo test --locked' _ "$ROOT_DIR"
run_case rust_ledger_test bash -lc 'cd "$1/services/ledger-gateway" && cargo test --locked' _ "$ROOT_DIR"
run_case reporting_unittest bash -lc 'cd "$1" && PYTHONPATH=services/reporting-analytics/src python3 -m unittest discover -s services/reporting-analytics/tests -v' _ "$ROOT_DIR"
run_case document_pytest bash -lc 'cd "$1" && PYTHONPATH=services/document-intelligence/src python3 -m pytest -q services/document-intelligence/tests' _ "$ROOT_DIR"
run_case control_plane_check bash -lc 'cd "$1/apps/control-plane" && pnpm check' _ "$ROOT_DIR"
run_case control_plane_all_tests bash -lc 'cd "$1/apps/control-plane" && pnpm test -- --run' _ "$ROOT_DIR"
run_case control_plane_integration_tests bash -lc 'cd "$1/apps/control-plane" && POSTGRES_INTEGRATION_TEST=1 pnpm exec vitest run server/*.integration.test.ts' _ "$ROOT_DIR"
run_case postgres_app_role_integration bash -lc 'cd "$1" && UMOJA_ASSURANCE_ENV=local_assurance scripts/infra/run_postgres_app_role_integration.sh' _ "$ROOT_DIR"

if command -v go >/dev/null 2>&1 && [[ -f "$ARTIFACT_DIR/go.coverprofile" ]]; then
  (cd "$ROOT_DIR/services/payment-engine" && go tool cover -func="$ARTIFACT_DIR/go.coverprofile") > "$ARTIFACT_DIR/go.coverage.txt" 2>&1 || true
fi
printf '%s\n' 'coverage_note=Rust and Python coverage providers are not invoked by the repository Makefile; Vitest coverage provider is not declared in apps/control-plane/package.json.' > "$ARTIFACT_DIR/coverage-note.txt"
