#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BIN_DIR="${ROOT_DIR}/.toolchain/bin"
CACHE_DIR="${ROOT_DIR}/.toolchain/cache"
GO_VERSION="1.25.0"
RUST_VERSION="1.89.0"
NODE_VERSION="20.19.4"
HELM_VERSION="3.16.4"
KUBECTL_VERSION="1.31.5"
PROMETHEUS_VERSION="2.55.1"
ALERTMANAGER_VERSION="0.27.0"
K6_VERSION="0.54.0"
ACT_VERSION="0.2.70"

mkdir -p "${BIN_DIR}" "${CACHE_DIR}"
export PATH="${BIN_DIR}:${PATH}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required bootstrap command: $1" >&2
    exit 1
  }
}

require_cmd curl
require_cmd tar
require_cmd sha256sum

host_arch="$(uname -m)"
case "${host_arch}" in
  x86_64) GO_ARCH="amd64"; KUBE_ARCH="amd64"; RELEASE_ARCH="amd64"; ACT_ARCH="x86_64"; RUST_HOST="x86_64-unknown-linux-gnu" ;;
  aarch64|arm64) GO_ARCH="arm64"; KUBE_ARCH="arm64"; RELEASE_ARCH="arm64"; ACT_ARCH="arm64"; RUST_HOST="aarch64-unknown-linux-gnu" ;;
  *) echo "unsupported architecture: ${host_arch}" >&2; exit 1 ;;
esac

fetch() {
  local url="$1" out="$2"
  if [[ ! -s "$out" ]]; then
    curl --fail --location --retry 4 --retry-delay 2 --proto '=https' --tlsv1.2 -o "$out" "$url"
  fi
}

install_go() {
  local archive="${CACHE_DIR}/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz"
  fetch "https://go.dev/dl/go${GO_VERSION}.linux-${GO_ARCH}.tar.gz" "$archive"
  rm -rf "${ROOT_DIR}/.toolchain/go"
  mkdir -p "${ROOT_DIR}/.toolchain/go"
  tar -xzf "$archive" -C "${ROOT_DIR}/.toolchain"
  ln -sfn "${ROOT_DIR}/.toolchain/go/bin/go" "${BIN_DIR}/go"
  ln -sfn "${ROOT_DIR}/.toolchain/go/bin/gofmt" "${BIN_DIR}/gofmt"
}

install_github_tarball() {
  local repo="$1" version="$2" asset="$3" binary="$4"
  local archive="${CACHE_DIR}/${binary}-${version}.tar.gz"
  fetch "https://github.com/${repo}/releases/download/v${version}/${asset}" "$archive"
  tar -xzf "$archive" -C "${CACHE_DIR}"
  local candidate
  candidate="$(find "${CACHE_DIR}" -type f -name "$binary" -perm -u+x | sort | tail -1)"
  [[ -n "$candidate" ]] || { echo "binary ${binary} not found in ${archive}" >&2; exit 1; }
  install -m 0755 "$candidate" "${BIN_DIR}/${binary}"
}

install_helm() {
  local archive="${CACHE_DIR}/helm-v${HELM_VERSION}-linux-${RELEASE_ARCH}.tar.gz"
  fetch "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${RELEASE_ARCH}.tar.gz" "$archive"
  tar -xzf "$archive" -C "${CACHE_DIR}"
  install -m 0755 "${CACHE_DIR}/linux-${RELEASE_ARCH}/helm" "${BIN_DIR}/helm"
}

install_kubectl() {
  fetch "https://dl.k8s.io/release/v${KUBECTL_VERSION}/bin/linux/${KUBE_ARCH}/kubectl" "${BIN_DIR}/kubectl"
  chmod 0755 "${BIN_DIR}/kubectl"
}

install_prometheus() {
  local archive="${CACHE_DIR}/prometheus-${PROMETHEUS_VERSION}.linux-${RELEASE_ARCH}.tar.gz"
  fetch "https://github.com/prometheus/prometheus/releases/download/v${PROMETHEUS_VERSION}/prometheus-${PROMETHEUS_VERSION}.linux-${RELEASE_ARCH}.tar.gz" "$archive"
  tar -xzf "$archive" -C "${CACHE_DIR}"
  install -m 0755 "${CACHE_DIR}/prometheus-${PROMETHEUS_VERSION}.linux-${RELEASE_ARCH}/promtool" "${BIN_DIR}/promtool"
}

install_alertmanager() {
  local archive="${CACHE_DIR}/alertmanager-${ALERTMANAGER_VERSION}.linux-${RELEASE_ARCH}.tar.gz"
  fetch "https://github.com/prometheus/alertmanager/releases/download/v${ALERTMANAGER_VERSION}/alertmanager-${ALERTMANAGER_VERSION}.linux-${RELEASE_ARCH}.tar.gz" "$archive"
  tar -xzf "$archive" -C "${CACHE_DIR}"
  install -m 0755 "${CACHE_DIR}/alertmanager-${ALERTMANAGER_VERSION}.linux-${RELEASE_ARCH}/amtool" "${BIN_DIR}/amtool"
}

install_k6() {
  local archive="${CACHE_DIR}/k6-v${K6_VERSION}-linux-${RELEASE_ARCH}.tar.gz"
  fetch "https://github.com/grafana/k6/releases/download/v${K6_VERSION}/k6-v${K6_VERSION}-linux-${RELEASE_ARCH}.tar.gz" "$archive"
  tar -xzf "$archive" -C "${CACHE_DIR}"
  local candidate
  candidate="$(find "${CACHE_DIR}" -type f -name k6 -perm -u+x | sort | tail -1)"
  [[ -n "$candidate" ]] || { echo "k6 binary not found" >&2; exit 1; }
  install -m 0755 "$candidate" "${BIN_DIR}/k6"
}

install_act() {
  local archive="${CACHE_DIR}/act_Linux_${ACT_ARCH}.tar.gz"
  fetch "https://github.com/nektos/act/releases/download/v${ACT_VERSION}/act_Linux_${ACT_ARCH}.tar.gz" "$archive"
  tar -xzf "$archive" -C "${CACHE_DIR}"
  install -m 0755 "${CACHE_DIR}/act" "${BIN_DIR}/act"
}

install_go
install_helm
install_kubectl
install_prometheus
install_alertmanager
install_k6
install_act

if ! command -v rustup >/dev/null 2>&1; then
  rustup_init="${CACHE_DIR}/rustup-init"
  fetch "https://static.rust-lang.org/rustup/dist/${RUST_HOST}/rustup-init" "$rustup_init"
  chmod 0755 "$rustup_init"
  "$rustup_init" -y --default-toolchain none --profile minimal
  export PATH="${HOME}/.cargo/bin:${PATH}"
fi
rustup toolchain install "${RUST_VERSION}" --profile minimal --component rustfmt --component clippy
rustup default "${RUST_VERSION}"

check_optional() {
  local cmd="$1"; local version
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf '%-16s %s\n' "$cmd" "MISSING"
    return
  fi
  case "$cmd" in
    go|kubectl|helm) version="$($cmd version 2>&1 | head -1 || true)" ;;
    *) version="$($cmd --version 2>&1 | head -1 || true)" ;;
  esac
  printf '%-16s %s\n' "$cmd" "$version"
}

printf '%s\n' 'UmojaFlowOS toolchain status:'
check_optional go
check_optional rustc
check_optional cargo
check_optional node
check_optional pnpm
check_optional python3
check_optional psql
check_optional docker
check_optional kubectl
check_optional helm
check_optional k6
check_optional promtool
check_optional amtool
check_optional act
printf '%s\n' "Tool binaries installed under ${BIN_DIR}. Add this directory to PATH in CI and local shells."
