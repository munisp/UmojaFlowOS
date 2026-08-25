#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
: "${OPENSEARCH_URL:?set private HTTPS OpenSearch URL}"
: "${OPENSEARCH_USER:?set OpenSearch audit user from secret manager}"
: "${OPENSEARCH_PASSWORD:?set OpenSearch password from secret manager}"

case "$OPENSEARCH_URL" in
  https://*) ;;
  *) echo 'OPENSEARCH_URL must use HTTPS' >&2; exit 2 ;;
esac

AUTH=(-u "${OPENSEARCH_USER}:${OPENSEARCH_PASSWORD}")
BASE="$OPENSEARCH_URL"
POLICY_ID=umoja-security-audit-v1-retention
TEMPLATE_FILE="$ROOT/infra/opensearch/umoja-security-audit-index-template.json"
POLICY_FILE="$ROOT/infra/opensearch/umoja-security-audit-ism-policy.json"

curl --fail-with-body --silent --show-error "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -X PUT "$BASE/_plugins/_ism/policies/$POLICY_ID" \
  --data-binary "@$POLICY_FILE"

curl --fail-with-body --silent --show-error "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -X PUT "$BASE/_index_template/umoja-security-audit-v1" \
  --data-binary "@$TEMPLATE_FILE"

curl --fail-with-body --silent --show-error "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -X PUT "$BASE/umoja-security-audit-v1-000001" \
  --data '{"aliases":{"umoja-security-audit-v1":{"is_write_index":true}}}'

echo 'opensearch_audit_ism=applied'
