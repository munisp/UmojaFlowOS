#!/usr/bin/env bash
# Runs the synthetic-monitor latency resilience test in a disposable local Kind cluster.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLUSTER_NAME="${KIND_CLUSTER_NAME:-umoja-retention-chaos}"
IMAGE="${SYNTHETIC_MONITOR_IMAGE:-umoja-retention-synthetic-monitor:kind}"
KEEP_CLUSTER="${KEEP_KIND_CLUSTER:-0}"
KIND_CONFIG="${KIND_CONFIG:-}"

require() {
  command -v "$1" >/dev/null 2>&1 || { echo "required command not found: $1" >&2; exit 127; }
}
for command in docker kind kubectl helm python3; do require "$command"; done

created_cluster=0
cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
  if [ "$KEEP_CLUSTER" != "1" ] && [ "$created_cluster" = "1" ]; then
    kind delete cluster --name "$CLUSTER_NAME" || true
  fi
}
trap cleanup EXIT

if ! kind get clusters | grep -Fxq "$CLUSTER_NAME"; then
  if [ -n "$KIND_CONFIG" ]; then
    kind create cluster --name "$CLUSTER_NAME" --config "$KIND_CONFIG"
  else
    kind create cluster --name "$CLUSTER_NAME"
  fi
  created_cluster=1
fi
kubectl config use-context "kind-$CLUSTER_NAME"

helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null
helm repo add chaos-mesh https://charts.chaos-mesh.org >/dev/null
helm repo update >/dev/null

helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --set grafana.enabled=false \
  --set alertmanager.enabled=true \
  --wait --timeout 10m

helm upgrade --install chaos-mesh chaos-mesh/chaos-mesh \
  --namespace chaos-mesh --create-namespace \
  --set dashboard.create=false \
  --set chaosDaemon.runtime=containerd \
  --set chaosDaemon.socketPath=/run/containerd/containerd.sock \
  --wait --timeout 10m

# Build locally and load into Kind; no registry credentials are required.
docker build -f "$ROOT/infra/retention-gateway/synthetic-monitor/Dockerfile" -t "$IMAGE" "$ROOT"
kind load docker-image "$IMAGE" --name "$CLUSTER_NAME"

kubectl create namespace security --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f "$ROOT/infra/retention-gateway/synthetic-monitor/kind-fixture/worker-metrics.yaml"
sed "s|ghcr.io/munisp/umojaflowos-retention-synthetic-monitor:REPLACE_WITH_IMMUTABLE_DIGEST|$IMAGE|" \
  "$ROOT/infra/retention-gateway/synthetic-monitor/kubernetes.yaml" \
  | sed 's/value: "15"/value: "5"/' \
  | kubectl apply -f -
kubectl apply -f "$ROOT/infra/retention-gateway/synthetic-monitor/prometheus-operator.yaml"

# kube-prometheus-stack selects these resources using its release label.
kubectl -n monitoring label servicemonitor umoja-retention-synthetic-monitor \
  release=kube-prometheus-stack --overwrite
kubectl -n monitoring label prometheusrule umoja-retention-synthetic-circuit-monitor \
  release=kube-prometheus-stack --overwrite

kubectl -n security rollout status deployment/umoja-retention-worker-metrics-fixture --timeout=120s
kubectl -n security rollout status deployment/umoja-retention-synthetic-monitor --timeout=120s

kubectl -n security port-forward service/umoja-retention-worker 18080:8080 >/tmp/umoja-kind-worker-port-forward.log 2>&1 &
kubectl -n security port-forward service/umoja-retention-synthetic-monitor 19468:9468 >/tmp/umoja-kind-monitor-port-forward.log 2>&1 &
sleep 3

RUN_CHAOS_MESH=1 \
CHAOS_NAMESPACE=security \
WORKER_METRICS_URL=http://127.0.0.1:18080/metrics \
SYNTHETIC_MONITOR_METRICS_URL=http://127.0.0.1:19468/metrics \
SYNTHETIC_MONITOR_CHAOS_SETTLE_SECONDS=12 \
python3 -m pytest -m chaos -q "$ROOT/tests/chaos_mesh/test_retention_worker_chaos.py" \
  -k synthetic_monitor_latency

echo "Kind synthetic-monitor latency resilience test: passed"
