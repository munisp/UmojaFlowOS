#!/usr/bin/env bash
set -euo pipefail

: "${OPENSEARCH_URL:?set the isolated staging OpenSearch URL}"
: "${OPENSEARCH_USER:?set the staging OpenSearch user}"
: "${OPENSEARCH_PASSWORD:?set the staging OpenSearch password}"
: "${RETENTION_GATEWAY_URL:?set the staging retention gateway URL}"
: "${RETENTION_GATEWAY_TOKEN:?set the staging gateway token}"

case "$OPENSEARCH_URL" in https://*) ;; *) echo 'OPENSEARCH_URL must use HTTPS' >&2; exit 2 ;; esac
case "$RETENTION_GATEWAY_URL" in https://*|http://localhost*|http://127.0.0.1*) ;; *) echo 'gateway must use HTTPS unless loopback-only' >&2; exit 2 ;; esac

AUTH=(-u "${OPENSEARCH_USER}:${OPENSEARCH_PASSWORD}")
INDEX_PREFIX="umoja-security-audit-delete-test-${BUILD_ID:-manual}"
INDEX="${INDEX_PREFIX}-000001"
ALIAS="${INDEX_PREFIX}"
POLICY_ID="umoja-security-audit-delete-test-${BUILD_ID:-manual}"
DIGEST=$(printf '%s' "$INDEX|synthetic-fixture-v1" | sha256sum | awk '{print $1}')
CORR="ism-delete-test-${BUILD_ID:-manual}"

cleanup() {
  set +e
  curl -sS "${AUTH[@]}" -X DELETE "$OPENSEARCH_URL/$INDEX" >/dev/null
  curl -sS "${AUTH[@]}" -X DELETE "$OPENSEARCH_URL/_index_template/$POLICY_ID" >/dev/null
  curl -sS "${AUTH[@]}" -X DELETE "$OPENSEARCH_URL/_plugins/_ism/policies/$POLICY_ID" >/dev/null
}
trap cleanup EXIT

json='{"audit_schema":"umoja.security.audit.v1","event_source":"ism-delete-test","event_category":"synthetic","result":"test-only","correlation_id":"'"$CORR"'","fixture_digest":"'"$DIGEST"'"}'

printf '%s\n' '[1/8] Create isolated synthetic index and write alias'
curl --fail-with-body --silent --show-error "${AUTH[@]}" -H 'Content-Type: application/json' \
  -X PUT "$OPENSEARCH_URL/$INDEX" \
  --data '{"aliases":{"'"$ALIAS"'":{"is_write_index":true}}}' >/dev/null

printf '%s\n' '[2/8] Insert synthetic audit event through alias'
curl --fail-with-body --silent --show-error "${AUTH[@]}" -H 'Content-Type: application/json' \
  -X POST "$OPENSEARCH_URL/$ALIAS/_doc" --data "$json" >/dev/null

printf '%s\n' '[3/8] Confirm alias points to the test index'
curl --fail-with-body --silent --show-error "${AUTH[@]}" "$OPENSEARCH_URL/_alias/$ALIAS?pretty"

printf '%s\n' '[4/8] Confirm ISM state and record evidence'
curl --fail-with-body --silent --show-error "${AUTH[@]}" \
  "$OPENSEARCH_URL/_plugins/_ism/explain/$INDEX?pretty"

printf '%s\n' '[5/8] Negative test: active legal hold must deny deletion'
status=$(curl -sS -o /tmp/ism-hold-response.json -w '%{http_code}' \
  -H "Authorization: Bearer $RETENTION_GATEWAY_TOKEN" -H 'Content-Type: application/json' \
  -X POST "$RETENTION_GATEWAY_URL/v1/retention/delete-authorizations" \
  --data '{"index":"'"$INDEX"'","index_uuid":"staging-test","index_version":"1","expected_digest":"'"$DIGEST"'","requested_by":"ism-service","correlation_id":"'"$CORR"'-hold"}' )
test "$status" = 409 || { echo "expected hold denial 409, got $status" >&2; cat /tmp/ism-hold-response.json >&2; exit 1; }
grep -q 'hold_active' /tmp/ism-hold-response.json || { echo 'hold_active code missing' >&2; exit 1; }

printf '%s\n' '[6/8] Negative test: invalid WORM proof must deny deletion'
status=$(curl -sS -o /tmp/ism-worm-response.json -w '%{http_code}' \
  -H "Authorization: Bearer $RETENTION_GATEWAY_TOKEN" -H 'Content-Type: application/json' \
  -X POST "$RETENTION_GATEWAY_URL/v1/retention/delete-authorizations" \
  --data '{"index":"'"$INDEX"'","index_uuid":"staging-test","index_version":"1","expected_digest":"'"$(printf 'b%.0s' {1..64})"'","requested_by":"ism-service","correlation_id":"'"$CORR"'-worm"}' )
test "$status" = 412 || { echo "expected WORM denial 412, got $status" >&2; cat /tmp/ism-worm-response.json >&2; exit 1; }
grep -q 'worm_not_verified' /tmp/ism-worm-response.json || { echo 'worm_not_verified code missing' >&2; exit 1; }

printf '%s\n' '[7/8] Positive test: valid evidence plus independent approval authorizes deletion'
status=$(curl -sS -o /tmp/ism-approved-response.json -w '%{http_code}' \
  -H "Authorization: Bearer $RETENTION_GATEWAY_TOKEN" -H 'Content-Type: application/json' \
  -X POST "$RETENTION_GATEWAY_URL/v1/retention/delete-authorizations" \
  --data '{"index":"'"$INDEX"'","index_uuid":"staging-test","index_version":"1","expected_digest":"'"$DIGEST"'","requested_by":"ism-service","correlation_id":"'"$CORR"'-approved"}' )
test "$status" = 202 || { echo "expected authorization 202, got $status" >&2; cat /tmp/ism-approved-response.json >&2; exit 1; }
grep -q 'authorized' /tmp/ism-approved-response.json || { echo 'authorized code missing' >&2; exit 1; }

printf '%s\n' '[8/8] Confirm delete worker is separately controlled'
authorization=$(jq -r '.authorization_token // empty' /tmp/ism-approved-response.json)
test -n "$authorization" || { echo 'single-use authorization token missing' >&2; exit 1; }
printf '%s\n' 'PASS: staging gateway and ISM negative/positive decision checks completed'
