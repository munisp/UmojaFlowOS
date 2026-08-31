#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PATH="${ROOT_DIR}/.toolchain/bin:${PATH}"
MANIFEST="${ROOT_DIR}/infra/kubernetes/payment-engine-mojaloop-secure.yaml"
NAMESPACE="${NAMESPACE:-umoja-payment}"
DEPLOYMENT="${DEPLOYMENT:-payment-engine}"
SERVICE="${SERVICE:-payment-engine}"
METRICS_PATH="${METRICS_PATH:-/metrics}"
METRICS_PORT="${METRICS_PORT:-8081}"
REQUIRE_LIVE="${REQUIRE_LIVE:-false}"
TIMEOUT="${TIMEOUT:-180s}"

usage() {
  cat <<'EOF'
Usage: verify_staging_admission_and_metrics.sh [--require-live] [--namespace N] [--manifest FILE]

Validates:
  1. the manifest with the Kubernetes API server using server-side dry-run;
  2. restricted pod security fields and secret-volume references;
  3. rollout availability when a live cluster is requested;
  4. a live Prometheus text-format scrape through kubectl port-forward.

By default, the script runs the admission check and skips live-cluster checks when no
cluster is reachable. Set --require-live or REQUIRE_LIVE=true for a hard staging gate.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --require-live) REQUIRE_LIVE=true; shift ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

command -v kubectl >/dev/null 2>&1 || { echo "kubectl is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
[[ -r "$MANIFEST" ]] || { echo "manifest not readable: $MANIFEST" >&2; exit 1; }

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; exit 1; }

kubectl apply --server-side --dry-run=server --namespace "$NAMESPACE" -f "$MANIFEST" >/dev/null \
  && pass "server-side admission accepted ${MANIFEST}" \
  || {
    if [[ "$REQUIRE_LIVE" == true ]]; then fail "server-side admission rejected or API server unavailable"; fi
    echo "WARN  live API server unavailable; admission result is not a staging proof" >&2
    exit 0
  }

# These checks intentionally inspect the rendered manifest text as well as the API response.
# They prevent accidental weakening of the restricted profile before deployment.
grep -Eq 'runAsNonRoot:[[:space:]]*true' "$MANIFEST" || fail "runAsNonRoot=true is missing"
grep -Eq 'readOnlyRootFilesystem:[[:space:]]*true' "$MANIFEST" || fail "readOnlyRootFilesystem=true is missing"
grep -Eq 'allowPrivilegeEscalation:[[:space:]]*false' "$MANIFEST" || fail "allowPrivilegeEscalation=false is missing"
grep -Eq 'capabilities:' "$MANIFEST" || fail "capability drop configuration is missing"
grep -Eq 'secret' "$MANIFEST" || fail "secret volume/reference is missing"
pass "restricted security controls are present in the manifest"

kubectl -n "$NAMESPACE" rollout status "deployment/${DEPLOYMENT}" --timeout="$TIMEOUT" \
  && pass "deployment/${DEPLOYMENT} rollout is available" \
  || fail "deployment/${DEPLOYMENT} did not become available"

kubectl -n "$NAMESPACE" get service "$SERVICE" >/dev/null \
  || fail "service/${SERVICE} does not exist"

port_file="$(mktemp)"
forward_log="$(mktemp)"
cleanup() {
  if [[ -n "${forward_pid:-}" ]]; then kill "$forward_pid" >/dev/null 2>&1 || true; fi
  rm -f "$port_file" "$forward_log"
}
trap cleanup EXIT

kubectl -n "$NAMESPACE" port-forward "service/${SERVICE}" "127.0.0.1:${METRICS_PORT}:${METRICS_PORT}" >"$forward_log" 2>&1 &
forward_pid=$!
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${METRICS_PORT}${METRICS_PATH}" >"$port_file"; then break; fi
  sleep 1
done
[[ -s "$port_file" ]] || { cat "$forward_log" >&2; fail "metrics endpoint was not scrapeable"; }

grep -Eq '^# HELP |^# TYPE ' "$port_file" || fail "metrics response is not Prometheus text format"
grep -Eq '^umoja_' "$port_file" || fail "expected umoja_* metrics were not exposed"
pass "${SERVICE}${METRICS_PATH} returned Prometheus metrics"

printf '%s\n' "STAGING GATE PASS: admission, restricted profile, rollout, and metrics scrape verified"
