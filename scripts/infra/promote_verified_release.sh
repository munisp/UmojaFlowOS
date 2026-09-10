#!/usr/bin/env bash
set -Eeuo pipefail

# Promote a verified release through a canary Deployment and Istio VirtualService.
# This script never opens settlement or promotes traffic unless every gate passes.

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
: "${RELEASE_REF:?RELEASE_REF must be an immutable commit or tag}"
: "${RELEASE_TAG:?RELEASE_TAG must be the signed release tag}"
: "${EVIDENCE_MANIFEST:?EVIDENCE_MANIFEST must point to the reviewed manifest}"
: "${IMAGE_REF:?IMAGE_REF must be an immutable image@sha256 digest}"
: "${CERT_IDENTITY_REGEXP:?CERT_IDENTITY_REGEXP is required}"
: "${CERT_OIDC_ISSUER:?CERT_OIDC_ISSUER is required}"
: "${EXPECTED_GPG_FINGERPRINT:?EXPECTED_GPG_FINGERPRINT is required}"
: "${NAMESPACE:?NAMESPACE is required}"
: "${RELEASE_NAME:?RELEASE_NAME is required}"
: "${CHART_DIR:?CHART_DIR must point to the Helm chart}"
: "${VIRTUALSERVICE_NAME:?VIRTUALSERVICE_NAME is required}"
: "${CANARY_HOST:?CANARY_HOST is required}"
: "${CANARY_VERIFY_SCRIPT:?CANARY_VERIFY_SCRIPT must be an executable canary verification script}"
: "${AUTHORIZED_DIRECTORY:?AUTHORIZED_DIRECTORY must be an externally supplied PKI authorization JSON}"

CANARY_RELEASE="${RELEASE_NAME}-canary"
CANARY_WEIGHT="${CANARY_WEIGHT:-10}"
CANARY_SETTLE_SECONDS="${CANARY_SETTLE_SECONDS:-120}"
PROMOTION_APPROVED="${PROMOTION_APPROVED:-}"
PRODUCTION_APPROVED="${PRODUCTION_APPROVED:-}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/artifacts/promotion-${RELEASE_REF}}"
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"
HELM_BIN="${HELM_BIN:-helm}"

cleanup_canary() {
  set +e
  "$KUBECTL_BIN" -n "$NAMESPACE" patch virtualservice "$VIRTUALSERVICE_NAME" \
    --type=json \
    -p='[{"op":"replace","path":"/spec/http/0/route/0/weight","value":100},{"op":"replace","path":"/spec/http/0/route/1/weight","value":0}]' >/dev/null 2>&1
  "$HELM_BIN" uninstall "$CANARY_RELEASE" --namespace "$NAMESPACE" >/dev/null 2>&1
}
trap 'status=$?; if [[ $status -ne 0 ]]; then cleanup_canary; fi; exit $status' EXIT

command -v "$KUBECTL_BIN" >/dev/null || { echo "missing kubectl" >&2; exit 69; }
command -v "$HELM_BIN" >/dev/null || { echo "missing helm" >&2; exit 69; }
[[ "$IMAGE_REF" =~ @sha256:[0-9a-f]{64}$ ]] || { echo "IMAGE_REF must end in immutable lowercase sha256 digest" >&2; exit 2; }
[[ "$CANARY_WEIGHT" =~ ^([1-9]|[1-9][0-9])$ ]] || { echo "CANARY_WEIGHT must be 1..99" >&2; exit 2; }
[[ "$PROMOTION_APPROVED" == APPROVED_STAGING_CANARY ]] || { echo "missing APPROVED_STAGING_CANARY" >&2; exit 2; }
[[ "$PRODUCTION_APPROVED" == APPROVED_PRODUCTION_PROMOTION ]] || { echo "missing APPROVED_PRODUCTION_PROMOTION" >&2; exit 2; }

mkdir -p "$OUTPUT_DIR"

RELEASE_SHA=$(git -C "$ROOT_DIR" rev-parse "$RELEASE_REF^{commit}")
"$ROOT_DIR/scripts/infra/verify_release_cryptography.sh" \
  --repo-dir "$ROOT_DIR" --release-sha "$RELEASE_SHA" --tag "$RELEASE_TAG" \
  --image "$IMAGE_REF" --certificate-identity-regexp "$CERT_IDENTITY_REGEXP" \
  --certificate-oidc-issuer "$CERT_OIDC_ISSUER" \
  --expected-gpg-fingerprint "$EXPECTED_GPG_FINGERPRINT" \
  --output-dir "$OUTPUT_DIR/cryptography"

python3 "$ROOT_DIR/scripts/infra/assert_production_evidence_provenance.py" \\
  --manifest "$EVIDENCE_MANIFEST"
python3 "$ROOT_DIR/scripts/infra/verify_role_sidecar_authorization.py" \\
  --manifest "$EVIDENCE_MANIFEST" \\
  --signatures-dir "$(dirname "$EVIDENCE_MANIFEST")/signatures" \\
  --authorized-directory "$AUTHORIZED_DIRECTORY" \
  --require-revocation-evidence
python3 "$ROOT_DIR/scripts/infra/verify_production_release_evidence.py" \
  --execution-mode production --manifest "$EVIDENCE_MANIFEST" --repo "$ROOT_DIR"
python3 "$ROOT_DIR/scripts/infra/validate_production_go_gate.py" \
  --execution-mode production --evidence-dir "$(dirname "$EVIDENCE_MANIFEST")" \
  --manifest "$EVIDENCE_MANIFEST" --signatures-dir "$(dirname "$EVIDENCE_MANIFEST")/signatures" \
  --image "$IMAGE_REF" | tee "$OUTPUT_DIR/go-gate.json"

"$HELM_BIN" upgrade --install "$CANARY_RELEASE" "$CHART_DIR" \
  --namespace "$NAMESPACE" --create-namespace --atomic --wait --timeout 10m \
  --set environment=staging \
  --set image.repository="${IMAGE_REF%@*}" \
  --set image.digest="${IMAGE_REF##*@}" \
  --set fullnameOverride="$CANARY_RELEASE" \
  --set releaseEvidence.manifestPath=/var/run/umoja/release/manifest.json

"$KUBECTL_BIN" -n "$NAMESPACE" rollout status deployment/"$CANARY_RELEASE" --timeout=10m
"$KUBECTL_BIN" -n "$NAMESPACE" get pods -l app.kubernetes.io/name=umoja-payment-engine -o wide | tee "$OUTPUT_DIR/canary-pods.txt"

# The VirtualService must already contain stable and canary destinations.
"$KUBECTL_BIN" -n "$NAMESPACE" patch virtualservice "$VIRTUALSERVICE_NAME" \
  --type=json \
  -p="[{\"op\":\"replace\",\"path\":\"/spec/http/0/route/0/weight\",\"value\":$((100-CANARY_WEIGHT))},{\"op\":\"replace\",\"path\":\"/spec/http/0/route/1/weight\",\"value\":$CANARY_WEIGHT}]"
sleep "$CANARY_SETTLE_SECONDS"

# Execute only an operator-supplied, pre-reviewed executable canary probe.
[[ -x "$CANARY_VERIFY_SCRIPT" ]] || { echo "CANARY_VERIFY_SCRIPT is not executable" >&2; exit 2; }
"$CANARY_VERIFY_SCRIPT" --host "$CANARY_HOST" | tee "$OUTPUT_DIR/canary-verification.txt"

# Promote the identical digest to the stable release, then send 100% traffic to it.
"$HELM_BIN" upgrade --install "$RELEASE_NAME" "$CHART_DIR" \
  --namespace "$NAMESPACE" --atomic --wait --timeout 10m \
  --set environment=production \
  --set image.repository="${IMAGE_REF%@*}" \
  --set image.digest="${IMAGE_REF##*@}" \
  --set releaseEvidence.manifestPath=/var/run/umoja/release/manifest.json
"$KUBECTL_BIN" -n "$NAMESPACE" rollout status deployment/"$RELEASE_NAME" --timeout=10m
"$KUBECTL_BIN" -n "$NAMESPACE" patch virtualservice "$VIRTUALSERVICE_NAME" \
  --type=json \
  -p='[{"op":"replace","path":"/spec/http/0/route/0/weight","value":0},{"op":"replace","path":"/spec/http/0/route/1/weight","value":100}]'

"$KUBECTL_BIN" -n "$NAMESPACE" get deployment/"$RELEASE_NAME" -o yaml > "$OUTPUT_DIR/production-deployment.yaml"
"$KUBECTL_BIN" -n "$NAMESPACE" get virtualservice "$VIRTUALSERVICE_NAME" -o yaml > "$OUTPUT_DIR/production-virtualservice.yaml"
printf 'PROMOTION_PASS release_sha=%s image=%s namespace=%s\n' "$RELEASE_SHA" "$IMAGE_REF" "$NAMESPACE" | tee "$OUTPUT_DIR/promotion-status.txt"
trap - EXIT
cleanup_canary
exit 0
