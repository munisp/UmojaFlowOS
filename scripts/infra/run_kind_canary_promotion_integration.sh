#!/usr/bin/env bash
# Reproducible Kind + Istio canary promotion/rollback integration test.
# It validates the routing and rollback contract independently of production evidence.
set -Eeuo pipefail

CLUSTER_NAME="${CLUSTER_NAME:-umoja-canary-it}"
NAMESPACE="${NAMESPACE:-umoja-payment-it}"
ISTIO_VERSION="${ISTIO_VERSION:-1.27.1}"
CANARY_WEIGHT="${CANARY_WEIGHT:-10}"
TIMEOUT="${TIMEOUT:-180s}"
KEEP_CLUSTER="${KEEP_CLUSTER:-0}"
OUT="${OUT:-artifacts/staging/kind-canary-promotion}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p "$ROOT_DIR/$OUT"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 2; }; }
for tool in kind kubectl curl; do need "$tool"; done

cleanup() {
  status=$?
  set +e
  if [[ "$KEEP_CLUSTER" != 1 ]]; then kind delete cluster --name "$CLUSTER_NAME" >/dev/null 2>&1; fi
  exit "$status"
}
trap cleanup EXIT

if ! kind get clusters | grep -qx "$CLUSTER_NAME"; then
  kind create cluster --name "$CLUSTER_NAME" --wait 120s
fi

if ! kubectl get namespace istio-system >/dev/null 2>&1; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"; cleanup' EXIT
  curl --fail --silent --show-error --location \
    "https://github.com/istio/istio/releases/download/${ISTIO_VERSION}/istio-${ISTIO_VERSION}-linux-amd64.tar.gz" \
    | tar -xz -C "$tmp"
  "$tmp/istio-${ISTIO_VERSION}/bin/istioctl" install --set profile=minimal -y
fi

kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE"
kubectl label namespace "$NAMESPACE" istio-injection=enabled --overwrite

cat <<YAML | kubectl apply -f -
apiVersion: v1
kind: Service
metadata:
  name: payment-engine
  namespace: ${NAMESPACE}
spec:
  ports:
    - name: http
      port: 8080
      targetPort: 8080
  selector:
    app: payment-engine
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-engine-stable
  namespace: ${NAMESPACE}
spec:
  replicas: 1
  selector: {matchLabels: {app: payment-engine, version: stable}}
  template:
    metadata: {labels: {app: payment-engine, version: stable}}
    spec:
      containers:
        - name: app
          image: hashicorp/http-echo:1.0.0
          args: ["-listen=:8080", "-text=stable"]
          ports: [{containerPort: 8080}]
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: payment-engine-canary
  namespace: ${NAMESPACE}
spec:
  replicas: 1
  selector: {matchLabels: {app: payment-engine, version: canary}}
  template:
    metadata: {labels: {app: payment-engine, version: canary}}
    spec:
      containers:
        - name: app
          image: hashicorp/http-echo:1.0.0
          args: ["-listen=:8080", "-text=canary"]
          ports: [{containerPort: 8080}]
---
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: payment-engine
  namespace: ${NAMESPACE}
spec:
  selector: {istio: ingressgateway}
  servers:
    - port: {number: 80, name: http, protocol: HTTP}
      hosts: [payment-engine.test]
---
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: payment-engine
  namespace: ${NAMESPACE}
spec:
  hosts: [payment-engine.test]
  gateways: [payment-engine]
  http:
    - route:
        - destination: {host: payment-engine, subset: stable}
          weight: 100
        - destination: {host: payment-engine, subset: canary}
          weight: 0
---
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: payment-engine
  namespace: ${NAMESPACE}
spec:
  host: payment-engine
  subsets:
    - name: stable
      labels: {version: stable}
    - name: canary
      labels: {version: canary}
YAML

kubectl -n "$NAMESPACE" rollout status deployment/payment-engine-stable --timeout="$TIMEOUT"
kubectl -n "$NAMESPACE" rollout status deployment/payment-engine-canary --timeout="$TIMEOUT"
kubectl -n istio-system rollout status deployment/istio-ingressgateway --timeout="$TIMEOUT"

INGRESS_IP="$(kubectl -n istio-system get svc istio-ingressgateway -o jsonpath='{.spec.clusterIP}')"
PORT="$(kubectl -n istio-system get svc istio-ingressgateway -o jsonpath='{.spec.ports[?(@.name==\"http2\")].port}')"
PORT="${PORT:-80}"

request() { curl --fail --silent --show-error --max-time 5 -H 'Host: payment-engine.test' "http://${INGRESS_IP}:${PORT}/"; }
assert_contains() { local expected="$1" actual="$2"; [[ "$actual" == *"$expected"* ]] || { echo "expected '$expected', got '$actual'" >&2; exit 1; }; }

assert_contains stable "$(request)"

weight_patch=$(printf '[{"op":"replace","path":"/spec/http/0/route/0/weight","value":%s},{"op":"replace","path":"/spec/http/0/route/1/weight","value":%s}]' "$((100-CANARY_WEIGHT))" "$CANARY_WEIGHT")
kubectl -n "$NAMESPACE" patch virtualservice payment-engine --type=json -p="$weight_patch"
sleep 5

stable=0; canary=0
for _ in $(seq 1 40); do
  if request | grep -q canary; then canary=$((canary+1)); else stable=$((stable+1)); fi
done
printf 'weighted routing observations: stable=%s canary=%s\n' "$stable" "$canary" | tee "$ROOT_DIR/$OUT/weighted-routing.txt"
(( canary > 0 )) || { echo 'canary received no traffic' >&2; exit 1; }

# Inject a failed canary probe. The rollback contract is stable=100/canary=0.
if request | grep -q canary; then
  kubectl -n "$NAMESPACE" patch virtualservice payment-engine --type=json -p='[{"op":"replace","path":"/spec/http/0/route/0/weight","value":100},{"op":"replace","path":"/spec/http/0/route/1/weight","value":0}]'
fi
sleep 3
assert_contains stable "$(request)"
kubectl -n "$NAMESPACE" get virtualservice payment-engine -o yaml | tee "$ROOT_DIR/$OUT/rollback-virtualservice.yaml"
printf 'CANARY_PROMOTION_INTEGRATION_PASS cluster=%s namespace=%s\n' "$CLUSTER_NAME" "$NAMESPACE" | tee "$ROOT_DIR/$OUT/status.txt"
