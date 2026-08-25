#!/usr/bin/env bash
# Apply or validate the security-preflight and APISIX protected-transport remediation.
# This script never creates certificates or credentials, starts services, or enables a provider.
set -euo pipefail

MODE="check"
if [[ "${1:-}" == "--apply" ]]; then
  MODE="apply"
elif [[ "${1:-}" != "" && "${1:-}" != "--check" ]]; then
  echo "usage: $0 [--check|--apply]" >&2
  exit 64
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFLIGHT="$ROOT/infra/security-stack/security-preflight.mjs"
PREFLIGHT_TEST="$ROOT/infra/security-stack/security-preflight.test.mjs"
COMPOSE="$ROOT/infra/security-stack/compose.yaml"
APISIX_CONFIG="$ROOT/infra/apisix/config.yaml"
APISIX_ROUTES="$ROOT/infra/apisix/apisix.yaml"
TRANSPORT_TEMPLATE="$ROOT/infra/security-stack/protected-transport.env.template"

for file in "$PREFLIGHT" "$PREFLIGHT_TEST" "$COMPOSE" "$APISIX_CONFIG" "$APISIX_ROUTES"; do
  [[ -f "$file" ]] || { echo "missing required file: $file" >&2; exit 1; }
done

is_remediated() {
  grep -Fq 'UMOJA_KEYCLOAK_CLIENT_ID' "$PREFLIGHT" &&
  grep -Fq 'UMOJA_KEYCLOAK_AUDIENCE' "$PREFLIGHT" &&
  grep -Fq 'UMOJA_OBJECT_STORAGE_SECRET_ACCESS_KEY' "$PREFLIGHT" &&
  grep -Fq 'UMOJA_APISIX_TRUST_BUNDLE_PATH' "$PREFLIGHT" &&
  grep -Fq 'KEYCLOAK_OIDC_DISCOVERY_URL: https://${UMOJA_PUBLIC_HOST}/realms/umojaflowos/.well-known/openid-configuration' "$COMPOSE" &&
  grep -Fq 'UMOJA_APISIX_TRUST_BUNDLE_PATH' "$COMPOSE" &&
  grep -Fq '"--tls-port", "6379"' "$COMPOSE" &&
  grep -Fq -- '--tls-cert-file=/run/umoja-tls/opa/tls.crt' "$COMPOSE" &&
  grep -Fq 'aliases:' "$COMPOSE" &&
  grep -Fq 'ssl_trusted_certificate: /etc/ssl/certs/umoja-internal-ca.pem' "$APISIX_CONFIG" &&
  grep -Fq 'client_secret: $ENV://UMOJA_KEYCLOAK_CLIENT_SECRET' "$APISIX_ROUTES" &&
  grep -Fxq '#END' "$APISIX_ROUTES" &&
  [[ -f "$TRANSPORT_TEMPLATE" ]] &&
  grep -Fq 'UMOJA_APISIX_TRUST_BUNDLE_PATH=' "$TRANSPORT_TEMPLATE"
}

save_backups() {
  local backup_dir
  backup_dir="${UMOJA_REMEDIATION_BACKUP_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/umojaflowos-protected-transport.XXXXXX")}"
  mkdir -p "$backup_dir"
  cp "$PREFLIGHT" "$backup_dir/security-preflight.mjs.before"
  cp "$PREFLIGHT_TEST" "$backup_dir/security-preflight.test.mjs.before"
  cp "$COMPOSE" "$backup_dir/compose.yaml.before"
  cp "$APISIX_CONFIG" "$backup_dir/apisix-config.yaml.before"
  cp "$APISIX_ROUTES" "$backup_dir/apisix-routes.yaml.before"
  echo "saved pre-remediation files in $backup_dir" >&2
}

write_preflight() {
  cat >"$PREFLIGHT" <<'EOF'
const REQUIRED = [
  "UMOJA_DEPLOYMENT_APPROVAL_ID",
  "UMOJA_PUBLIC_HOST",
  "UMOJA_TLS_CONTACT_EMAIL",
  "UMOJA_CONTROL_PLANE_IMAGE",
  "UMOJA_PAYMENT_ENGINE_IMAGE",
  "UMOJA_CONTROL_POSTGRES_DATABASE",
  "UMOJA_CONTROL_POSTGRES_OWNER",
  "UMOJA_CONTROL_POSTGRES_OWNER_PASSWORD",
  "UMOJA_APP_DB_USER",
  "UMOJA_APP_DB_PASSWORD",
  "UMOJA_KEYCLOAK_POSTGRES_DATABASE",
  "UMOJA_KEYCLOAK_POSTGRES_OWNER",
  "UMOJA_KEYCLOAK_POSTGRES_OWNER_PASSWORD",
  "UMOJA_KEYCLOAK_BOOTSTRAP_ADMIN",
  "UMOJA_KEYCLOAK_BOOTSTRAP_PASSWORD",
  "UMOJA_KEYCLOAK_CLIENT_ID",
  "UMOJA_KEYCLOAK_AUDIENCE",
  "UMOJA_KEYCLOAK_CLIENT_SECRET",
  "UMOJA_SESSION_SECRET",
  "UMOJA_REDIS_PASSWORD",
  "UMOJA_OBJECT_STORAGE_ENDPOINT",
  "UMOJA_OBJECT_STORAGE_BUCKET",
  "UMOJA_OBJECT_STORAGE_ACCESS_KEY_ID",
  "UMOJA_OBJECT_STORAGE_SECRET_ACCESS_KEY",
  "UMOJA_APISIX_TRUST_BUNDLE_PATH",
  "UMOJA_REDIS_TLS_MATERIAL_PATH",
  "UMOJA_OPA_TLS_MATERIAL_PATH",
  "UMOJA_OPA_BUNDLE_DIGEST",
  "UMOJA_KEYCLOAK_REALM_SHA256",
  "UMOJA_CADDY_TLS_MODE",
  "UMOJA_PROVIDER_ACTIVATION_EVIDENCE_URI",
  "UMOJA_TIGERBEETLE_CLUSTER_EVIDENCE_URI",
  "UMOJA_MODEL_RUNTIME_CAPACITY_EVIDENCE_URI",
  "UMOJA_EMAIL_DELIVERY_EVIDENCE_URI",
  "UMOJA_CONTROLLED_TEST_EVIDENCE_URI",
  "UMOJA_YELLOWCARD_WEBHOOK_ALLOWED_CIDRS",
  "UMOJA_YELLOWCARD_WEBHOOK_SECRET_REFERENCE",
  "UMOJA_YELLOWCARD_REPLAY_REDIS_PASSWORD_SECRET_REFERENCE",
  "UMOJA_YELLOWCARD_MATERIAL_MOUNT_PATH",
];

const SECRET_KEYS = new Set([
  "UMOJA_CONTROL_POSTGRES_OWNER_PASSWORD",
  "UMOJA_APP_DB_PASSWORD",
  "UMOJA_KEYCLOAK_POSTGRES_OWNER_PASSWORD",
  "UMOJA_KEYCLOAK_BOOTSTRAP_PASSWORD",
  "UMOJA_KEYCLOAK_CLIENT_SECRET",
  "UMOJA_SESSION_SECRET",
  "UMOJA_REDIS_PASSWORD",
  "UMOJA_OBJECT_STORAGE_SECRET_ACCESS_KEY",
]);
const FILE_REFERENCE_KEYS = new Set([
  "UMOJA_YELLOWCARD_WEBHOOK_SECRET_REFERENCE",
  "UMOJA_YELLOWCARD_REPLAY_REDIS_PASSWORD_SECRET_REFERENCE",
]);
const MOUNT_PATH_KEYS = new Set([
  "UMOJA_YELLOWCARD_MATERIAL_MOUNT_PATH",
]);
const TLS_PATH_KEYS = new Set([
  "UMOJA_APISIX_TRUST_BUNDLE_PATH",
  "UMOJA_REDIS_TLS_MATERIAL_PATH",
  "UMOJA_OPA_TLS_MATERIAL_PATH",
]);
const PLACEHOLDER = /change[-_ ]?me|example|replace[-_ ]?me|todo|placeholder/i;

function isPrivateServiceEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return host === "minio" || host.endsWith(".internal") || host.endsWith(".local") || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  } catch {
    return false;
  }
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Returns only configuration key names and safety reasons. Secret values are
 * deliberately never included in output, logs, thrown errors, or telemetry.
 */
export function validateSecurityStackEnvironment(env) {
  const blockers = new Map();
  const block = (key, reason) => {
    if (!blockers.has(key)) blockers.set(key, reason);
  };
  for (const key of REQUIRED) {
    const value = env[key];
    if (typeof value !== "string" || value.trim().length === 0) block(key, "missing");
    else if (PLACEHOLDER.test(value)) block(key, "placeholder_value");
  }

  if (typeof env.UMOJA_DEPLOYMENT_APPROVAL_ID === "string" && !/^SEC-[A-Z0-9][A-Z0-9-]{5,}$/i.test(env.UMOJA_DEPLOYMENT_APPROVAL_ID)) {
    block("UMOJA_DEPLOYMENT_APPROVAL_ID", "invalid_security_approval_reference");
  }
  for (const key of ["UMOJA_CONTROL_PLANE_IMAGE", "UMOJA_PAYMENT_ENGINE_IMAGE"]) {
    if (typeof env[key] === "string" && !/@sha256:[a-f0-9]{64}$/i.test(env[key])) block(key, "immutable_image_digest_required");
  }
  for (const key of ["UMOJA_OPA_BUNDLE_DIGEST", "UMOJA_KEYCLOAK_REALM_SHA256"]) {
    if (typeof env[key] === "string" && !/^sha256:[a-f0-9]{64}$/i.test(env[key])) block(key, "sha256_digest_required");
  }
  if (typeof env.UMOJA_OBJECT_STORAGE_ENDPOINT === "string" && !isPrivateServiceEndpoint(env.UMOJA_OBJECT_STORAGE_ENDPOINT)) {
    block("UMOJA_OBJECT_STORAGE_ENDPOINT", "private_https_storage_endpoint_required");
  }
  if (typeof env.UMOJA_CADDY_TLS_MODE === "string" && !["managed", "external"].includes(env.UMOJA_CADDY_TLS_MODE)) {
    block("UMOJA_CADDY_TLS_MODE", "approved_tls_mode_required");
  }
  for (const key of ["UMOJA_PROVIDER_ACTIVATION_EVIDENCE_URI", "UMOJA_TIGERBEETLE_CLUSTER_EVIDENCE_URI", "UMOJA_MODEL_RUNTIME_CAPACITY_EVIDENCE_URI", "UMOJA_EMAIL_DELIVERY_EVIDENCE_URI", "UMOJA_CONTROLLED_TEST_EVIDENCE_URI"]) {
    if (typeof env[key] === "string" && !isHttpsUrl(env[key])) block(key, "https_evidence_reference_required");
  }
  for (const key of SECRET_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0 && value.trim().length < 24) block(key, "minimum_secret_length_not_met");
  }
  for (const key of TLS_PATH_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0 && !value.startsWith("/")) block(key, "absolute_secret_mount_path_required");
  }
  for (const key of MOUNT_PATH_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0 && !value.startsWith("/")) block(key, "absolute_secret_mount_path_required");
  }
  for (const key of FILE_REFERENCE_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0 && !/^file:\/\/\/[^?#]+$/.test(value)) block(key, "managed_file_secret_reference_required");
  }

  const result = [...blockers.entries()].map(([key, reason]) => ({ key, reason }));
  return { ready: result.length === 0, blockers: result };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const result = validateSecurityStackEnvironment(process.env);
  process.stdout.write(`${JSON.stringify({ status: result.ready ? "ready_for_security_owner_review" : "not_ready", blockers: result.blockers })}\n`);
  process.exitCode = result.ready ? 0 : 1;
}
EOF
}

write_preflight_test() {
  cat >"$PREFLIGHT_TEST" <<'EOF'
import assert from "node:assert/strict";
import test from "node:test";
import { validateSecurityStackEnvironment } from "./security-preflight.mjs";

const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const secret = "a-deliberately-long-managed-secret-reference-value";

function validEnvironment() {
  return {
    UMOJA_DEPLOYMENT_APPROVAL_ID: "SEC-2026-UMOJA-001",
    UMOJA_PUBLIC_HOST: "control.umoja.internal",
    UMOJA_TLS_CONTACT_EMAIL: "security@umoja.internal",
    UMOJA_CONTROL_PLANE_IMAGE: `registry.umoja.internal/umojaflowos/control-plane@${digest}`,
    UMOJA_PAYMENT_ENGINE_IMAGE: `registry.umoja.internal/umojaflowos/payment-engine@${digest}`,
    UMOJA_CONTROL_POSTGRES_DATABASE: "control",
    UMOJA_CONTROL_POSTGRES_OWNER: "control_owner",
    UMOJA_CONTROL_POSTGRES_OWNER_PASSWORD: secret,
    UMOJA_APP_DB_USER: "control_app",
    UMOJA_APP_DB_PASSWORD: secret,
    UMOJA_KEYCLOAK_POSTGRES_DATABASE: "identity",
    UMOJA_KEYCLOAK_POSTGRES_OWNER: "identity_owner",
    UMOJA_KEYCLOAK_POSTGRES_OWNER_PASSWORD: secret,
    UMOJA_KEYCLOAK_BOOTSTRAP_ADMIN: "security-admin",
    UMOJA_KEYCLOAK_BOOTSTRAP_PASSWORD: secret,
    UMOJA_KEYCLOAK_CLIENT_ID: "umojaflowos-gateway",
    UMOJA_KEYCLOAK_AUDIENCE: "umojaflowos-gateway",
    UMOJA_KEYCLOAK_CLIENT_SECRET: secret,
    UMOJA_SESSION_SECRET: secret,
    UMOJA_REDIS_PASSWORD: secret,
    UMOJA_OBJECT_STORAGE_ENDPOINT: "https://minio.security.internal",
    UMOJA_OBJECT_STORAGE_BUCKET: "kyc-evidence",
    UMOJA_OBJECT_STORAGE_ACCESS_KEY_ID: "object-storage-access-id-001",
    UMOJA_OBJECT_STORAGE_SECRET_ACCESS_KEY: secret,
    UMOJA_APISIX_TRUST_BUNDLE_PATH: "/run/secret-injector/ca.pem",
    UMOJA_REDIS_TLS_MATERIAL_PATH: "/run/secret-injector/redis",
    UMOJA_OPA_TLS_MATERIAL_PATH: "/run/secret-injector/opa",
    UMOJA_OPA_BUNDLE_DIGEST: digest,
    UMOJA_KEYCLOAK_REALM_SHA256: digest,
    UMOJA_CADDY_TLS_MODE: "external",
    UMOJA_PROVIDER_ACTIVATION_EVIDENCE_URI: "https://evidence.umoja.internal/provider-activation",
    UMOJA_TIGERBEETLE_CLUSTER_EVIDENCE_URI: "https://evidence.umoja.internal/tigerbeetle-cluster",
    UMOJA_MODEL_RUNTIME_CAPACITY_EVIDENCE_URI: "https://evidence.umoja.internal/model-runtime",
    UMOJA_EMAIL_DELIVERY_EVIDENCE_URI: "https://evidence.umoja.internal/email-delivery",
    UMOJA_CONTROLLED_TEST_EVIDENCE_URI: "https://evidence.umoja.internal/controlled-test",
    UMOJA_YELLOWCARD_WEBHOOK_ALLOWED_CIDRS: "203.0.113.0/24",
    UMOJA_YELLOWCARD_WEBHOOK_SECRET_REFERENCE: "file:///run/secret-injector/yellowcard/webhook-current",
    UMOJA_YELLOWCARD_REPLAY_REDIS_PASSWORD_SECRET_REFERENCE: "file:///run/secret-injector/yellowcard/replay-redis-password",
    UMOJA_YELLOWCARD_MATERIAL_MOUNT_PATH: "/run/secret-injector/yellowcard",
  };
}

test("accepts the canonical runtime and protected-transport environment", () => {
  assert.deepEqual(validateSecurityStackEnvironment(validEnvironment()), { ready: true, blockers: [] });
});

test("rejects unsafe endpoints and never returns secret material", () => {
  const environment = validEnvironment();
  environment.UMOJA_OBJECT_STORAGE_ENDPOINT = "https://storage.public.example";
  environment.UMOJA_SESSION_SECRET = "change-me";
  const result = validateSecurityStackEnvironment(environment);
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers.map(blocker => blocker.key).sort(), ["UMOJA_OBJECT_STORAGE_ENDPOINT", "UMOJA_SESSION_SECRET"]);
  assert.equal(JSON.stringify(result).includes(environment.UMOJA_SESSION_SECRET), false);
});

test("rejects non-absolute TLS material mount paths", () => {
  const environment = validEnvironment();
  environment.UMOJA_OPA_TLS_MATERIAL_PATH = "relative/opa";
  assert.deepEqual(validateSecurityStackEnvironment(environment), {
    ready: false,
    blockers: [{ key: "UMOJA_OPA_TLS_MATERIAL_PATH", reason: "absolute_secret_mount_path_required" }],
  });
});
EOF
}

write_apisix_config() {
  cat >"$APISIX_CONFIG" <<'EOF'
apisix:
  node_listen: 9080
  enable_admin: false
  enable_admin_cors: false
  ssl:
    # Trusts the required public roots plus the private CA used by Redis and OPA.
    # The complete trust bundle is mounted read-only by Compose.
    ssl_trusted_certificate: /etc/ssl/certs/umoja-internal-ca.pem
deployment:
  role: data_plane
  role_data_plane:
    config_provider: yaml
nginx_config:
  error_log_level: warn
  http:
    keepalive_timeout: 60s
    client_header_timeout: 10s
    client_body_timeout: 10s
    send_timeout: 15s
EOF
}

write_transport_template() {
  cat >"$TRANSPORT_TEMPLATE" <<'EOF'
# Protected service TLS material — safe to commit and intentionally incomplete.
# Host paths must be populated by an approved secret manager or deployment
# injector. They must not point to repository files or contain secret values.

# PEM trust bundle containing the required public roots and the private CA used
# by Redis and OPA. It is mounted into APISIX for verified TLS connections.
UMOJA_APISIX_TRUST_BUNDLE_PATH=

# Each directory is mounted read-only and must contain tls.crt and tls.key.
# Required subject alternative names:
#   Caddy exposes the canonical public issuer hostname on the protected network.
#   Redis:    redis
#   OPA:      opa
UMOJA_REDIS_TLS_MATERIAL_PATH=
UMOJA_OPA_TLS_MATERIAL_PATH=

# APISIX resolves the canonical public issuer hostname through Caddy's protected-
# network alias on port 443. Never use a public Internet hairpin or disable TLS verify.
UMOJA_PROTECTED_TRANSPORT_ENABLED=false
UMOJA_PROTECTED_TRANSPORT_FAIL_CLOSED=true
EOF
}

apply_compose() {
  perl -0pi -e 's#      KEYCLOAK_OIDC_DISCOVERY_URL: \$\{KEYCLOAK_OIDC_DISCOVERY_URL:\?set the external HTTPS discovery URL\}#      KEYCLOAK_OIDC_DISCOVERY_URL: https://\${UMOJA_PUBLIC_HOST}/realms/umojaflowos/.well-known/openid-configuration#' "$COMPOSE"
  perl -0pi -e 's#      KEYCLOAK_OIDC_DISCOVERY_URL: https://\$\{UMOJA_PUBLIC_HOST\}/realms/umojaflowos/\.well-known/openid-configuration\n#      KEYCLOAK_OIDC_DISCOVERY_URL: https://\${UMOJA_PUBLIC_HOST}/realms/umojaflowos/.well-known/openid-configuration\n      UMOJA_KEYCLOAK_CLIENT_SECRET: \${UMOJA_KEYCLOAK_CLIENT_SECRET:?supply through a managed secret injector}\n#' "$COMPOSE"

  perl -0pi -e 's#        client_id: umojaflowos-gateway\n        realm: umojaflowos#        client_id: umojaflowos-gateway\n        client_secret: \$ENV://UMOJA_KEYCLOAK_CLIENT_SECRET\n        realm: umojaflowos#' "$APISIX_ROUTES"
  if ! grep -Fxq '#END' "$APISIX_ROUTES"; then
    printf '\n#END\n' >> "$APISIX_ROUTES"
  fi

  perl -0pi -e 's#      - \../apisix/apisix.yaml:/usr/local/apisix/conf/apisix.yaml:ro#      - ../apisix/apisix.yaml:/usr/local/apisix/conf/apisix.yaml:ro\n      - \${UMOJA_APISIX_TRUST_BUNDLE_PATH:?supply the private CA certificate through a managed secret injector}:/etc/ssl/certs/umoja-internal-ca.pem:ro#' "$COMPOSE"

  perl -0pi -e 's#    command: \["run", "--server", "--addr=0\.0\.0\.0:8181", "/policies"\]#    command: ["run", "--server", "--addr=0.0.0.0:8181", "--tls-cert-file=/run/umoja-tls/opa/tls.crt", "--tls-private-key-file=/run/umoja-tls/opa/tls.key", "/policies"]#' "$COMPOSE"
  perl -0pi -e 's#      - \../opa:/policies:ro#      - ../opa:/policies:ro\n      - \${UMOJA_OPA_TLS_MATERIAL_PATH:?supply OPA TLS material through a managed secret injector}:/run/umoja-tls/opa:ro#' "$COMPOSE"

  perl -0pi -e 's#    command: \["redis-server", "--appendonly", "yes", "--protected-mode", "yes", "--requirepass", "\$\{UMOJA_REDIS_PASSWORD:\?supply through a managed secret injector\}"\]#    command: ["redis-server", "--appendonly", "yes", "--protected-mode", "yes", "--port", "0", "--tls-port", "6379", "--tls-cert-file", "/run/umoja-tls/redis/tls.crt", "--tls-key-file", "/run/umoja-tls/redis/tls.key", "--tls-ca-cert-file", "/run/umoja-tls/redis/ca.crt", "--tls-auth-clients", "no", "--requirepass", "\${UMOJA_REDIS_PASSWORD:?supply through a managed secret injector}"]#' "$COMPOSE"
  perl -0pi -e 's#      - redis-data:/data#      - redis-data:/data\n      - \${UMOJA_REDIS_TLS_MATERIAL_PATH:?supply Redis TLS material through a managed secret injector}:/run/umoja-tls/redis:ro#' "$COMPOSE"
  perl -0pi -e 's#redis-cli --no-auth-warning -a "\$\$UMOJA_REDIS_PASSWORD" ping#redis-cli --tls --cacert /run/umoja-tls/redis/ca.crt -h redis --no-auth-warning -a "\$\$UMOJA_REDIS_PASSWORD" ping#' "$COMPOSE"

  perl -0pi -e 's#    networks:\n      - edge\n      - protected\n    security_opt:#    networks:\n      edge:\n      protected:\n        aliases:\n          - \${UMOJA_PUBLIC_HOST:?set a real public hostname}\n    security_opt:#' "$COMPOSE"
}

if [[ "$MODE" == "apply" ]] && ! is_remediated; then
  save_backups
  write_preflight
  write_preflight_test
  write_apisix_config
  write_transport_template
  apply_compose
fi

is_remediated || { echo "security-preflight or protected transport remediation is incomplete" >&2; exit 1; }
echo "security-preflight and protected APISIX transport remediation validated."
