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

install_kubectl(){
  local out="${TOOLS_DIR}/kubectl"
  [[ -x "${out}" ]] && { "${out}" version --client --output=yaml > "${ARTIFACT_DIR}/kubectl-version.yaml" 2>&1 || true; return; }
  curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/${OS}/${ARCH}/kubectl" -o "${out}.tmp"
  if [[ -n "${KUBECTL_SHA256:-}" ]]; then
    printf '%s  %s\n' "${KUBECTL_SHA256}" "${out}.tmp" | sha256sum -c -
  elif [[ "${ALLOW_UNVERIFIED_DOWNLOADS:-false}" != true ]]; then
    die "KUBECTL_SHA256 is required for a new download; set it only from the official release checksum"
  fi
  install -m 0755 "${out}.tmp" "${out}"; rm -f "${out}.tmp"
}

install_helm(){
  local out="${TOOLS_DIR}/helm" tmp="${ARTIFACT_DIR}/helm.tgz"
  [[ -x "${out}" ]] && { "${out}" version > "${ARTIFACT_DIR}/helm-version.txt" 2>&1 || true; return; }
  curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-${OS}-${ARCH}.tar.gz" -o "${tmp}"
  if [[ -n "${HELM_SHA256:-}" ]]; then
    printf '%s  %s\n' "${HELM_SHA256}" "${tmp}" | sha256sum -c -
  elif [[ "${ALLOW_UNVERIFIED_DOWNLOADS:-false}" != true ]]; then
    die "HELM_SHA256 is required for a new download; set it only from the official release checksum"
  fi
  tar -xzf "${tmp}" -C "${ARTIFACT_DIR}"
  install -m 0755 "${ARTIFACT_DIR}/${OS}-${ARCH}/helm" "${out}"
  "${out}" version > "${ARTIFACT_DIR}/helm-version.txt"
}

install_kind(){
  local out="${TOOLS_DIR}/kind"
  [[ -x "${out}" ]] && { "${out}" version > "${ARTIFACT_DIR}/kind-version.txt" 2>&1 || true; return; }
  curl -fsSL "https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-${OS}-${ARCH}" -o "${out}.tmp"
  if [[ -n "${KIND_SHA256:-}" ]]; then
    printf '%s  %s\n' "${KIND_SHA256}" "${out}.tmp" | sha256sum -c -
  elif [[ "${ALLOW_UNVERIFIED_DOWNLOADS:-false}" != true ]]; then
    die "KIND_SHA256 is required for a new download; set it only from the official release checksum"
  fi
  install -m 0755 "${out}.tmp" "${out}"; rm -f "${out}.tmp"
  "${out}" version > "${ARTIFACT_DIR}/kind-version.txt"
}

install_kubectl
install_helm
install_kind
export PATH="${TOOLS_DIR}:${PATH}"

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
