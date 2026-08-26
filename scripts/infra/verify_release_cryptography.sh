#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage:
  verify_release_cryptography.sh \
    --repo-dir PATH \
    --release-sha 40-char-lowercase-sha \
    --tag SIGNED_TAG \
    --image REGISTRY/IMAGE@sha256:64-hex \
    --certificate-identity-regexp REGEXP \
    --certificate-oidc-issuer URL \
    --expected-gpg-fingerprint FINGERPRINT \
    --output-dir PATH

The script verifies, but never creates, release signatures or attestations.
USAGE
  exit 2
}

REPO_DIR=""
RELEASE_SHA=""
RELEASE_TAG=""
IMAGE_REF=""
CERT_IDENTITY_REGEXP=""
CERT_OIDC_ISSUER=""
EXPECTED_GPG_FINGERPRINT=""
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir) REPO_DIR=${2:?missing value}; shift 2 ;;
    --release-sha) RELEASE_SHA=${2:?missing value}; shift 2 ;;
    --tag) RELEASE_TAG=${2:?missing value}; shift 2 ;;
    --image) IMAGE_REF=${2:?missing value}; shift 2 ;;
    --certificate-identity-regexp) CERT_IDENTITY_REGEXP=${2:?missing value}; shift 2 ;;
    --certificate-oidc-issuer) CERT_OIDC_ISSUER=${2:?missing value}; shift 2 ;;
    --expected-gpg-fingerprint) EXPECTED_GPG_FINGERPRINT=${2:?missing value}; shift 2 ;;
    --output-dir) OUTPUT_DIR=${2:?missing value}; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$REPO_DIR" && -n "$RELEASE_SHA" && -n "$RELEASE_TAG" && -n "$IMAGE_REF" && \
  -n "$CERT_IDENTITY_REGEXP" && -n "$CERT_OIDC_ISSUER" && \
  -n "$EXPECTED_GPG_FINGERPRINT" && -n "$OUTPUT_DIR" ]] || usage

[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo "invalid lowercase release SHA" >&2; exit 1; }
[[ "$IMAGE_REF" =~ @sha256:[a-f0-9]{64}$ ]] || { echo "image must use an immutable @sha256 digest" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
command -v cosign >/dev/null || { echo "cosign is required for provenance verification" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required for provenance payload binding" >&2; exit 1; }

mkdir -p "$OUTPUT_DIR"

git -C "$REPO_DIR" fetch --quiet origin "refs/tags/${RELEASE_TAG}:refs/tags/${RELEASE_TAG}"
test "$(git -C "$REPO_DIR" cat-file -t "$RELEASE_TAG")" = "tag" || {
  echo "release reference is not a signed annotated tag: $RELEASE_TAG" >&2
  exit 1
}
git -C "$REPO_DIR" verify-tag --raw "$RELEASE_TAG" > "$OUTPUT_DIR/tag-verification.txt" 2>&1
actual_tag_sha=$(git -C "$REPO_DIR" rev-parse "${RELEASE_TAG}^{commit}")
test "$actual_tag_sha" = "$RELEASE_SHA" || {
  echo "signed tag resolves to $actual_tag_sha, expected $RELEASE_SHA" >&2
  exit 1
}
actual_fingerprint=$(git -C "$REPO_DIR" show -s --format='%GF' "$RELEASE_TAG")
test "$actual_fingerprint" = "$EXPECTED_GPG_FINGERPRINT" || {
  echo "tag signer fingerprint mismatch" >&2
  exit 1
}
printf 'tag=%s\ncommit=%s\nsigner_fingerprint=%s\n' "$RELEASE_TAG" "$actual_tag_sha" "$actual_fingerprint" > "$OUTPUT_DIR/tag-binding.txt"

cosign verify-attestation "$IMAGE_REF" \
  --type slsaprovenance \
  --certificate-identity-regexp "$CERT_IDENTITY_REGEXP" \
  --certificate-oidc-issuer "$CERT_OIDC_ISSUER" \
  --output json > "$OUTPUT_DIR/provenance-verification.json"

jq -e --arg sha "$RELEASE_SHA" '
  [ .[]? | .payload? // empty | @base64d | fromjson
    | .. | objects | select(has("sha1")) | .sha1 ]
  | any(. == $sha)
' "$OUTPUT_DIR/provenance-verification.json" >/dev/null || {
  echo "verified provenance does not contain the expected source commit SHA" >&2
  exit 1
}
printf 'image=%s\nsource_commit=%s\n' "$IMAGE_REF" "$RELEASE_SHA" > "$OUTPUT_DIR/provenance-binding.txt"
echo "release cryptography verification: PASSED"
