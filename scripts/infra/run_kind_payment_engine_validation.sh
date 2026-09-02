#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TOOLS_DIR="${ROOT_DIR}/.tools/bin"
ARTIFACT_DIR="${ROOT_DIR}/artifacts/staging/kind-validation/$(date -u +%Y%m%dT%H%M%SZ)"
CLUSTER_NAME="${KIND_CLUSTER_NAME:-umoja-staging}"
NAMESPACE="${UMOJA_NAMESPACE:-umoja-payment}"
KUBECTL_VERSION="${KUBECTL_VERSION:-v1.31.4}"
HELM_VERSION="${HELM_VERSION:-v3.16.4}"
KIND_VERSION="${KIND_VERSION:-v0.25.0}"
RECREATE_CLUSTER="${RECREATE_CLUSTER:-false}"

mkdir -p "${TOOLS_DIR}" "${ARTIFACT_DIR}"
log(){ printf '[kind-validation] %s\n' "$*" | tee -a "${ARTIFACT_DIR}/runner.log"; }
die(){ log "FAIL-CLOSED: $*"; exit 1; }

arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo amd64;;
    aarch64|arm64) echo arm64;;
    *) die "unsupported architecture: $(uname -m)";;
  esac
}
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(arch)"

verify_binary_checksum(){
  local name="$1" path="$2" expected="$3"
  if [[ -n "$expected" ]]; then
    printf '%s  %s\n' "$expected" "$path" | sha256sum -c -
  elif [[ "${ALLOW_UNVERIFIED_DOWNLOADS:-false}" != true || "${CI:-false}" == true ]]; then
    die "${name} checksum is required; unverified downloads are forbidden in CI"
  else
    log "WARNING: accepting unverified local-only ${name} binary"
  fi
}

install_kubectl(){
  local out="${TOOLS_DIR}/kubectl"
  if [[ -x "${out}" ]]; then
    verify_binary_checksum kubectl "${out}" "${KUBECTL_SHA256:-}"
    "${out}" version --client --output=yaml > "${ARTIFACT_DIR}/kubectl-version.yaml" 2>&1 || true
    return
  fi
  curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/${OS}/${ARCH}/kubectl" -o "${out}.tmp"
  verify_binary_checksum kubectl "${out}.tmp" "${KUBECTL_SHA256:-}"
  install -m 0755 "${out}.tmp" "${out}"; rm -f "${out}.tmp"
}

install_helm(){
  local out="${TOOLS_DIR}/helm" tmp="${ARTIFACT_DIR}/helm.tgz"
  if [[ -x "${out}" ]]; then
    verify_binary_checksum helm "${out}" "${HELM_BINARY_SHA256:-}"
    "${out}" version > "${ARTIFACT_DIR}/helm-version.txt" 2>&1 || true
    return
  fi
  curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-${OS}-${ARCH}.tar.gz" -o "${tmp}"
  verify_binary_checksum helm-archive "${tmp}" "${HELM_SHA256:-}"
  tar -xzf "${tmp}" -C "${ARTIFACT_DIR}"
  install -m 0755 "${ARTIFACT_DIR}/${OS}-${ARCH}/helm" "${out}"
  "${out}" version > "${ARTIFACT_DIR}/helm-version.txt"
}

install_kind(){
  local out="${TOOLS_DIR}/kind"
  if [[ -x "${out}" ]]; then
    verify_binary_checksum kind "${out}" "${KIND_SHA256:-}"
    "${out}" version > "${ARTIFACT_DIR}/kind-version.txt" 2>&1 || true
    return
  fi
  curl -fsSL "https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-${OS}-${ARCH}" -o "${out}.tmp"
  verify_binary_checksum kind "${out}.tmp" "${KIND_SHA256:-}"
  install -m 0755 "${out}.tmp" "${out}"; rm -f "${out}.tmp"
  "${out}" version > "${ARTIFACT_DIR}/kind-version.txt"
}

if [[ "${CI:-false}" == true && "${ALLOW_UNVERIFIED_DOWNLOADS:-false}" == true ]]; then
  die "ALLOW_UNVERIFIED_DOWNLOADS cannot be enabled in CI"
fi
install_kubectl
install_helm
install_kind
export PATH="${TOOLS_DIR}:${PATH}"

run_static_checks(){
  log "running repository-static validation"
  python3 -m py_compile \
    "${ROOT_DIR}/scripts/infra/validate_prometheus_adapter_hpa.py" \
    "${ROOT_DIR}/scripts/infra/validate_fabric_queue_worker_scaling.py" \
    "${ROOT_DIR}/scripts/infra/validate_fabric_object_storage_bindings.py" \
    "${ROOT_DIR}/scripts/infra/validate_production_go_gate.py"
  python3 "${ROOT_DIR}/scripts/infra/validate_fabric_queue_worker_scaling.py" > "${ARTIFACT_DIR}/queue-worker-static-validation.txt"
  python3 "${ROOT_DIR}/scripts/infra/validate_fabric_object_storage_bindings.py" > "${ARTIFACT_DIR}/object-storage-binding-validation.txt"
  python3 "${ROOT_DIR}/scripts/infra/test_verify_release_manifest_signatures.py" > "${ARTIFACT_DIR}/release-signature-validation.txt"
  python3 "${ROOT_DIR}/tests/infra/test_release_signature_aggregation.py" > "${ARTIFACT_DIR}/release-signature-aggregation.txt"
}
run_static_checks

for tool in kubectl helm kind; do command -v "${tool}" >/dev/null || die "${tool} unavailable after installation"; done
command -v docker >/dev/null || die "Docker is required for Kind; no local container runtime is available"
docker info > "${ARTIFACT_DIR}/docker-info.txt" 2>&1 || die "Docker daemon is not reachable"

if kind get clusters | grep -qx "${CLUSTER_NAME}"; then
  [[ "${RECREATE_CLUSTER}" == true ]] || log "using existing Kind cluster ${CLUSTER_NAME}"
  if [[ "${RECREATE_CLUSTER}" == true ]]; then kind delete cluster --name "${CLUSTER_NAME}"; fi
fi
if ! kind get clusters | grep -qx "${CLUSTER_NAME}"; then
  kind create cluster --name "${CLUSTER_NAME}" --wait 120s > "${ARTIFACT_DIR}/kind-create.log" 2>&1
fi
kubectl config use-context "kind-${CLUSTER_NAME}" > "${ARTIFACT_DIR}/context.log"
kubectl version --short > "${ARTIFACT_DIR}/cluster-version.txt" 2>&1 || kubectl version > "${ARTIFACT_DIR}/cluster-version.txt" 2>&1
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f - > "${ARTIFACT_DIR}/namespace-apply.txt"
kubectl create namespace observability --dry-run=client -o yaml | kubectl apply -f - > "${ARTIFACT_DIR}/observability-namespace-apply.txt"

kubectl apply -f "${ROOT_DIR}/infra/monitoring/prometheus-adapter-fabric-queue.yaml" > "${ARTIFACT_DIR}/adapter-config-apply.txt"
python3 "${ROOT_DIR}/scripts/infra/validate_prometheus_adapter_hpa.py" --context "kind-${CLUSTER_NAME}" --namespace "${NAMESPACE}" > "${ARTIFACT_DIR}/adapter-hpa-validation.json"

# The chart intentionally requires real production values. For local validation,
# callers must provide a real digest and disposable test secrets/PVC through values.
: "${HELM_VALUES_FILE:?HELM_VALUES_FILE must point to an isolated Kind values file}"
helm upgrade --install umoja-payment-engine "${ROOT_DIR}/deploy/helm/umoja-payment-engine" \
  --namespace "${NAMESPACE}" --create-namespace --values "${HELM_VALUES_FILE}" \
  --wait --timeout 5m > "${ARTIFACT_DIR}/helm-upgrade.log" 2>&1
kubectl rollout status deployment/umoja-payment-engine-umoja-payment-engine -n "${NAMESPACE}" --timeout=180s > "${ARTIFACT_DIR}/rollout-status.txt"
kubectl get pods,svc,hpa -n "${NAMESPACE}" -o yaml > "${ARTIFACT_DIR}/workload-state.yaml"
python3 "${ROOT_DIR}/scripts/infra/validate_prometheus_adapter_hpa.py" --context "kind-${CLUSTER_NAME}" --namespace "${NAMESPACE}" > "${ARTIFACT_DIR}/adapter-hpa-validation-final.json"
printf '{"status":"PASS","live_cluster_evidence":true,"cluster":"%s","namespace":"%s","artifact_dir":"%s"}\n' "${CLUSTER_NAME}" "${NAMESPACE}" "${ARTIFACT_DIR}" | tee "${ARTIFACT_DIR}/result.json"
