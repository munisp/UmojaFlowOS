const REQUIRED = [
  "UMOJA_DEPLOYMENT_APPROVAL_ID",
  "UMOJA_PUBLIC_HOST",
  "UMOJA_TLS_CONTACT_EMAIL",
  "UMOJA_CONTROL_PLANE_IMAGE",
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
  if (typeof env.UMOJA_CONTROL_PLANE_IMAGE === "string" && !/@sha256:[a-f0-9]{64}$/i.test(env.UMOJA_CONTROL_PLANE_IMAGE)) {
    block("UMOJA_CONTROL_PLANE_IMAGE", "immutable_image_digest_required");
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

  const result = [...blockers.entries()].map(([key, reason]) => ({ key, reason }));
  return { ready: result.length === 0, blockers: result };
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const result = validateSecurityStackEnvironment(process.env);
  process.stdout.write(`${JSON.stringify({ status: result.ready ? "ready_for_security_owner_review" : "not_ready", blockers: result.blockers })}\n`);
  process.exitCode = result.ready ? 0 : 1;
}
