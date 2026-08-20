import assert from "node:assert/strict";
import test from "node:test";
import { validateSecurityStackEnvironment } from "./security-preflight.mjs";

const digest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const secret = "a-deliberately-long-managed-secret-reference-value";

function validEnvironment() {
  return {
    UMOJA_DEPLOYMENT_APPROVAL_ID: "SEC-2026-UMOJA-001",
    UMOJA_PUBLIC_HOST: "control.umoja.internal",
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
    UMOJA_REDIS_PASSWORD: secret,
    UMOJA_OIDC_ISSUER: "https://control.umoja.internal/realms/umojaflowos",
    UMOJA_OIDC_CLIENT_ID: "umojaflowos-control-plane",
    UMOJA_OIDC_CLIENT_SECRET: secret,
    UMOJA_SESSION_SECRET: secret,
    UMOJA_STORAGE_ENDPOINT: "https://minio.security.internal",
    UMOJA_STORAGE_BUCKET: "kyc-evidence",
    UMOJA_STORAGE_ACCESS_KEY: secret,
    UMOJA_STORAGE_SECRET_KEY: secret,
    UMOJA_OPA_BUNDLE_DIGEST: digest,
    UMOJA_KEYCLOAK_REALM_SHA256: digest,
    UMOJA_CADDY_TLS_MODE: "external",
  };
}

test("accepts a fully pinned, private, security-approved environment", () => {
  assert.deepEqual(validateSecurityStackEnvironment(validEnvironment()), { ready: true, blockers: [] });
});

test("rejects unsafe endpoints and never returns secret material", () => {
  const environment = validEnvironment();
  environment.UMOJA_STORAGE_ENDPOINT = "https://storage.public.example";
  environment.UMOJA_SESSION_SECRET = "change-me";
  const result = validateSecurityStackEnvironment(environment);
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers.map(blocker => blocker.key).sort(), ["UMOJA_SESSION_SECRET", "UMOJA_STORAGE_ENDPOINT"]);
  assert.equal(JSON.stringify(result).includes(environment.UMOJA_SESSION_SECRET), false);
});
