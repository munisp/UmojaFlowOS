#!/usr/bin/env bash
set -Eeuo pipefail

MODE=local
TARGET=""
LATENCY_MS="10"
DURATION="3s"
OUT_DIR="artifacts/staging/grpc-benchmark"
OTEL_PROMETHEUS_URL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) MODE=local; shift ;;
    --live) MODE=live; shift ;;
    --target) TARGET="$2"; shift 2 ;;
    --latency-ms) LATENCY_MS="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --otel-prometheus-url) OTEL_PROMETHEUS_URL="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$repo_root/$OUT_DIR"
run_id="$(date -u +%Y%m%dT%H%M%SZ)"
out="$repo_root/$OUT_DIR/run-$run_id"
mkdir -p "$out"

if [[ "$MODE" == live ]]; then
  : "${TARGET:?--target is required in --live mode}"
  command -v ghz >/dev/null || { echo 'ghz is required for --live mode' >&2; exit 2; }
  command -v kubectl >/dev/null || { echo 'kubectl is required for --live mode' >&2; exit 2; }
  command -v istioctl >/dev/null || { echo 'istioctl is required for --live mode' >&2; exit 2; }
  istioctl proxy-status >"$out/proxy-status.txt"
  istioctl analyze -n "${PAYMENT_NS:-umoja-payment}" >"$out/istio-analyze.txt"
  kubectl -n "${PAYMENT_NS:-umoja-payment}" get pods,svc -l app.kubernetes.io/name=payment-engine -o wide >"$out/workload.txt"
  kubectl -n "${PAYMENT_NS:-umoja-payment}" exec deploy/payment-engine -c istio-proxy -- pilot-agent request GET stats >"$out/envoy-stats.txt"
  for workers in 32 64 128 256; do
    ghz --call=umoja.settlement.v1.Settlement/Execute \
      --data-file="${SETTLEMENT_GRPC_REQUEST_FILE:?SETTLEMENT_GRPC_REQUEST_FILE is required}" \
      --concurrency="$workers" --connections="${SETTLEMENT_GRPC_CONNECTIONS:-2}" \
      --duration="$DURATION" --format=json "$TARGET" >"$out/ghz-workers-$workers.json"
  done
else
  go_bin="${GO_BIN:-$repo_root/.toolchain/go/bin/go}"
  [[ -x "$go_bin" ]] || go_bin="$(command -v go || true)"
  [[ -x "$go_bin" ]] || { echo 'Go is required for --local mode' >&2; exit 2; }
  cd "$repo_root/services/payment-engine"
  UMOJA_MESH_LATENCY_MS="$LATENCY_MS" "$go_bin" test ./internal/settlement \
    -run '^$' -bench '^BenchmarkSettlementPooledConcurrent$' -benchmem \
    -benchtime="$DURATION" -count=3 -cpu=32,64,128,256 \
    >"$out/local-benchmark.txt" 2>&1
fi

if [[ -n "$OTEL_PROMETHEUS_URL" ]]; then
  curl --fail --silent --show-error "$OTEL_PROMETHEUS_URL/-/ready" >"$out/prometheus-ready.txt"
  curl --fail --silent --show-error "$OTEL_PROMETHEUS_URL/api/v1/query" \
    --data-urlencode 'query=up{job=~"otel|payment-engine|istio.*"}' >"$out/otel-up.json"
fi
cat >"$out/metadata.json" <<EOF
{
  "run_id": "$run_id",
  "mode": "$MODE",
  "target": "$TARGET",
  "latency_ms": $LATENCY_MS,
  "duration": "$DURATION",
  "worker_levels": [32, 64, 128, 256],
  "full_istio_evidence": $([[ "$MODE" == live ]] && echo true || echo false),
  "otel_query_collected": $([[ -n "$OTEL_PROMETHEUS_URL" ]] && echo true || echo false)
}
EOF
printf '%s\n' "$out"
