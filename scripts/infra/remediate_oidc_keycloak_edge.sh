#!/usr/bin/env bash
# Apply or validate the checked-in OIDC/Keycloak edge remediation.
# This script never creates credentials, contacts an identity provider, or starts containers.
set -euo pipefail

MODE="check"
if [[ "${1:-}" == "--apply" ]]; then
  MODE="apply"
elif [[ "${1:-}" != "" && "${1:-}" != "--check" ]]; then
  echo "usage: $0 [--check|--apply]" >&2
  exit 64
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$ROOT/infra/security-stack/compose.yaml"
CADDY="$ROOT/infra/caddy/Caddyfile"

for file in "$COMPOSE" "$CADDY"; do
  [[ -f "$file" ]] || { echo "missing required file: $file" >&2; exit 1; }
done

compose_is_remediated() {
  grep -Fq 'POSTGRES_DATABASE_URL: postgresql://${UMOJA_APP_DB_USER' "$COMPOSE" &&
  grep -Fq 'UMOJA_KEYCLOAK_ISSUER: https://${UMOJA_PUBLIC_HOST}/realms/umojaflowos' "$COMPOSE" &&
  grep -Fq 'UMOJA_KEYCLOAK_CLIENT_ID: ${UMOJA_KEYCLOAK_CLIENT_ID:?set the Keycloak client identifier}' "$COMPOSE" &&
  grep -Fq 'UMOJA_KEYCLOAK_AUDIENCE: ${UMOJA_KEYCLOAK_AUDIENCE:?set the Keycloak audience}' "$COMPOSE" &&
  grep -Fq 'UMOJA_PUBLIC_BASE_URL: https://${UMOJA_PUBLIC_HOST}' "$COMPOSE" &&
  grep -Fq 'UMOJA_OBJECT_STORAGE_ENDPOINT: ${UMOJA_OBJECT_STORAGE_ENDPOINT:?set the private S3-compatible endpoint}' "$COMPOSE" &&
  grep -Fq 'UMOJA_OBJECT_STORAGE_BUCKET: ${UMOJA_OBJECT_STORAGE_BUCKET:?set the approved evidence bucket}' "$COMPOSE"
}

caddy_is_remediated() {
  grep -Fq '@keycloak_realm path /realms/* /resources/*' "$CADDY" &&
  grep -Fq 'reverse_proxy keycloak:8080' "$CADDY" &&
  grep -Fq '@control_plane_auth path /auth/*' "$CADDY" &&
  grep -Fq '@api path /api/* /payment-engine/* /risk-compliance/* /ledger-gateway/* /reporting/*' "$CADDY"
}

if [[ "$MODE" == "apply" ]]; then
  if ! compose_is_remediated || ! caddy_is_remediated; then
    BACKUP_DIR="${UMOJA_REMEDIATION_BACKUP_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/umojaflowos-oidc-remediation.XXXXXX")}"
    mkdir -p "$BACKUP_DIR"
    cp "$COMPOSE" "$BACKUP_DIR/compose.yaml.before"
    cp "$CADDY" "$BACKUP_DIR/Caddyfile.before"
    echo "saved pre-remediation files in $BACKUP_DIR" >&2
  fi

  if ! compose_is_remediated; then
    perl -0pi -e 's#\n      UMOJA_POSTGRES_URL: postgresql://\$\{UMOJA_APP_DB_USER:\?supply through a managed secret injector\}:\$\{UMOJA_APP_DB_PASSWORD:\?supply through a managed secret injector\}\@postgres:5432/\$\{UMOJA_CONTROL_POSTGRES_DATABASE:\?set the control-plane PostgreSQL database name\}\n      UMOJA_OIDC_ISSUER: \$\{UMOJA_OIDC_ISSUER:\?set the external HTTPS issuer\}\n      UMOJA_OIDC_CLIENT_ID: \$\{UMOJA_OIDC_CLIENT_ID:\?set the Keycloak client identifier\}\n      UMOJA_OIDC_CLIENT_SECRET: \$\{UMOJA_OIDC_CLIENT_SECRET:\?supply through a managed secret injector\}\n      UMOJA_SESSION_SECRET: \$\{UMOJA_SESSION_SECRET:\?supply through a managed secret injector\}\n      UMOJA_STORAGE_ENDPOINT: \$\{UMOJA_STORAGE_ENDPOINT:\?set the private S3-compatible endpoint\}\n      UMOJA_STORAGE_BUCKET: \$\{UMOJA_STORAGE_BUCKET:\?set the approved evidence bucket\}\n      UMOJA_STORAGE_ACCESS_KEY: \$\{UMOJA_STORAGE_ACCESS_KEY:\?supply through a managed secret injector\}\n      UMOJA_STORAGE_SECRET_KEY: \$\{UMOJA_STORAGE_SECRET_KEY:\?supply through a managed secret injector\}#\n      POSTGRES_DATABASE_URL: postgresql://\${UMOJA_APP_DB_USER:?supply through a managed secret injector}:\${UMOJA_APP_DB_PASSWORD:?supply through a managed secret injector}\@postgres:5432/\${UMOJA_CONTROL_POSTGRES_DATABASE:?set the control-plane PostgreSQL database name}\n      UMOJA_KEYCLOAK_ISSUER: https://\${UMOJA_PUBLIC_HOST}/realms/umojaflowos\n      UMOJA_KEYCLOAK_CLIENT_ID: \${UMOJA_KEYCLOAK_CLIENT_ID:?set the Keycloak client identifier}\n      UMOJA_KEYCLOAK_AUDIENCE: \${UMOJA_KEYCLOAK_AUDIENCE:?set the Keycloak audience}\n      UMOJA_KEYCLOAK_CLIENT_SECRET: \${UMOJA_KEYCLOAK_CLIENT_SECRET:?supply through a managed secret injector}\n      UMOJA_PUBLIC_BASE_URL: https://\${UMOJA_PUBLIC_HOST}\n      UMOJA_SESSION_SECRET: \${UMOJA_SESSION_SECRET:?supply through a managed secret injector}\n      UMOJA_OBJECT_STORAGE_ENDPOINT: \${UMOJA_OBJECT_STORAGE_ENDPOINT:?set the private S3-compatible endpoint}\n      UMOJA_OBJECT_STORAGE_BUCKET: \${UMOJA_OBJECT_STORAGE_BUCKET:?set the approved evidence bucket}\n      UMOJA_OBJECT_STORAGE_ACCESS_KEY_ID: \${UMOJA_OBJECT_STORAGE_ACCESS_KEY_ID:?supply through a managed secret injector}\n      UMOJA_OBJECT_STORAGE_SECRET_ACCESS_KEY: \${UMOJA_OBJECT_STORAGE_SECRET_ACCESS_KEY:?supply through a managed secret injector}#s' "$COMPOSE"
  fi

  if ! caddy_is_remediated; then
    perl -0pi -e 's#  \@api path /api/\* /auth/\* /payment-engine/\* /risk-compliance/\* /ledger-gateway/\* /reporting/\*\n  handle \@api \{#  \@keycloak_realm path /realms/* /resources/*\n  handle \@keycloak_realm {\n    reverse_proxy keycloak:8080 {\n      header_up X-Forwarded-Proto https\n      header_up X-Request-ID {http.request.uuid}\n    }\n  }\n  \@control_plane_auth path /auth/*\n  handle \@control_plane_auth {\n    reverse_proxy {\$UMOJA_CONTROL_PLANE_UPSTREAM:http://control-plane:3000} {\n      header_up X-Forwarded-Proto https\n      header_up X-Request-ID {http.request.uuid}\n    }\n  }\n  \@api path /api/* /payment-engine/* /risk-compliance/* /ledger-gateway/* /reporting/*\n  handle \@api {#s' "$CADDY"
  fi
fi

compose_is_remediated || { echo "OIDC runtime environment remediation is incomplete" >&2; exit 1; }
caddy_is_remediated || { echo "Keycloak realm and control-plane auth edge routing remediation is incomplete" >&2; exit 1; }

echo "OIDC environment and Keycloak edge routing remediation validated."
