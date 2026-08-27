#!/usr/bin/env bash
set -euo pipefail
umask 077

: "${VAULT_ADDR:?VAULT_ADDR is required}"
: "${VAULT_TOKEN:?VAULT_TOKEN is required}"
: "${KEYCLOAK_BASE_URL:?KEYCLOAK_BASE_URL is required}"
: "${KEYCLOAK_REALM:?KEYCLOAK_REALM is required}"
: "${KEYCLOAK_ADMIN_CLIENT_ID:?KEYCLOAK_ADMIN_CLIENT_ID is required}"
: "${KEYCLOAK_ADMIN_CLIENT_SECRET:?KEYCLOAK_ADMIN_CLIENT_SECRET is required}"
: "${KEYCLOAK_CLIENT_ID:?KEYCLOAK_CLIENT_ID is required}"
: "${KEYCLOAK_SECRET_VERSION:?KEYCLOAK_SECRET_VERSION is required}"
: "${CANARY_URL:?CANARY_URL is required}"
: "${CANARY_RELEASE_SHA:?CANARY_RELEASE_SHA is required}"
: "${CANARY_RUN_ID:?CANARY_RUN_ID is required}"
: "${CANARY_PATH:?CANARY_PATH is required}"

vault_path="${VAULT_SECRET_PATH:-secret/data/umoja/keycloak/evidence-publisher}"
rotation_active=0

record_metric() {
  local event="$1"
  if [ -n "${ROTATION_METRICS_STATE_FILE:-}" ] && [ -n "${ROTATION_METRICS_FILE:-}" ]; then
    python3 "${ROTATION_METRICS_RECORDER:-scripts/infra/record_keycloak_rotation_metric.py}" \
      "$event" --state-file "$ROTATION_METRICS_STATE_FILE" --metrics-file "$ROTATION_METRICS_FILE" >/dev/null
  fi
}
admin_token=""
client_uuid=""
new_secret=""

cleanup() {
  unset admin_token client_uuid new_secret
}
trap cleanup EXIT

vault_write() {
  local secret_value="$1" version="$2" operation="$3"
  local payload
  payload="$(jq -cn \
    --arg client_id "$KEYCLOAK_CLIENT_ID" \
    --arg client_secret "$secret_value" \
    --arg previous_version "$KEYCLOAK_SECRET_VERSION" \
    --arg current_version "$version" \
    --arg operation "$operation" \
    '{data:{client_id:$client_id,client_secret:$client_secret,previous_version:$previous_version,current_version:$current_version,operation:$operation}}')"
  curl --fail-with-body --silent --show-error \
    --request POST \
    --header "X-Vault-Token: $VAULT_TOKEN" \
    --header 'Content-Type: application/json' \
    --data-binary "$payload" \
    "$VAULT_ADDR/v1/$vault_path" \
    | jq -e '.data.created_time | strings | length > 0' >/dev/null
}

get_admin_token() {
  curl --fail-with-body --silent --show-error \
    --data-urlencode 'grant_type=client_credentials' \
    --data-urlencode "client_id=$KEYCLOAK_ADMIN_CLIENT_ID" \
    --data-urlencode "client_secret=$KEYCLOAK_ADMIN_CLIENT_SECRET" \
    "$KEYCLOAK_BASE_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
    | jq -er '.access_token'
}

find_client() {
  curl --fail-with-body --silent --show-error \
    --header "Authorization: Bearer $admin_token" \
    "$KEYCLOAK_BASE_URL/admin/realms/$KEYCLOAK_REALM/clients?clientId=$(printf %s "$KEYCLOAK_CLIENT_ID" | jq -sRr @uri)" \
    | jq -er 'if length == 1 then .[0].id else error("client lookup is not unique") end'
}

generate_secret() {
  curl --fail-with-body --silent --show-error \
    --request PUT \
    --header "Authorization: Bearer $admin_token" \
    "$KEYCLOAK_BASE_URL/admin/realms/$KEYCLOAK_REALM/clients/$client_uuid/client-secret" \
    | jq -er '.value | strings | select(length >= 32)'
}

canary() {
  local secret="$1" body digest token
  token="$(curl --fail-with-body --silent --show-error \
    --data-urlencode 'grant_type=client_credentials' \
    --data-urlencode "client_id=$KEYCLOAK_CLIENT_ID" \
    --data-urlencode "client_secret=$secret" \
    "$KEYCLOAK_BASE_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/token" \
    | jq -er '.access_token')"
  body="$(jq -cn --arg sha "$CANARY_RELEASE_SHA" --arg run "$CANARY_RUN_ID" '{evidence_id:"CANARY",release_sha:$sha,run_id:$run,result:"secret-rotation-canary"}')"
  digest="$(printf %s "$body" | sha256sum | awk '{print $1}')"
  curl --fail-with-body --silent --show-error \
    --request PUT \
    --header "Authorization: Bearer $token" \
    --header 'Content-Type: application/json' \
    --header "X-Evidence-SHA256: $digest" \
    --data "$body" \
    "$CANARY_URL/v1/evidence/$CANARY_RELEASE_SHA/$CANARY_RUN_ID/$CANARY_PATH" \
    | jq -e --arg digest "$digest" '.status == "stored" and .sha256 == $digest' >/dev/null
  unset token
}

rollback() {
  local recovery_secret recovery_version
  if [ "$rotation_active" -ne 1 ]; then return 0; fi
  recovery_secret="$(generate_secret)" || { record_metric rollback_failure || true; echo 'ROLLBACK_FAILED: Keycloak recovery rotation failed' >&2; return 1; }
  echo '::add-mask::'"$recovery_secret"
  recovery_version="$(date -u +%Y%m%dT%H%M%SZ)-rollback-${GITHUB_RUN_ID:-manual}"
  vault_write "$recovery_secret" "$recovery_version" compensating_rollback || { record_metric rollback_failure || true; echo 'ROLLBACK_FAILED: Vault recovery write failed' >&2; return 1; }
  canary "$recovery_secret" || { record_metric rollback_failure || true; echo 'ROLLBACK_FAILED: recovery canary failed' >&2; return 1; }
  printf 'rollback_version=%s\n' "$recovery_version" >> "${GITHUB_OUTPUT:-/dev/null}"
  echo 'ROTATION_ROLLED_BACK: recovery secret installed and canary passed' >&2
  rotation_active=0
}

on_error() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    record_metric rotation_failure || true
  fi
  if [ "$status" -ne 0 ] && [ "$rotation_active" -eq 1 ]; then
    rollback || status=1
  fi
  exit "$status"
}
trap on_error ERR

admin_token="$(get_admin_token)"
client_uuid="$(find_client)"
new_secret="$(generate_secret)"
echo '::add-mask::'"$new_secret"
rotation_active=1
new_version="$(date -u +%Y%m%dT%H%M%SZ)-${GITHUB_RUN_ID:-manual}"
vault_write "$new_secret" "$new_version" primary_rotation
canary "$new_secret"
rotation_active=0
printf 'rotation_version=%s\n' "$new_version" >> "${GITHUB_OUTPUT:-/dev/null}"
printf 'rotation_status=success\n'
