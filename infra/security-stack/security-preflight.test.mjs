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
