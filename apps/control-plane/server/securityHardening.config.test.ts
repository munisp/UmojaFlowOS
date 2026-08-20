import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd(), "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("defense-in-depth deployment configuration", () => {
  it("requires Caddy TLS-facing response protections and routes protected APIs through the gateway", () => {
    const caddy = read("infra/caddy/Caddyfile");
    expect(caddy).toContain("Strict-Transport-Security");
    expect(caddy).toContain("Content-Security-Policy");
    expect(caddy).toContain("frame-ancestors 'none'");
    expect(caddy).toContain("reverse_proxy {$UMOJA_APISIX_UPSTREAM");
  });

  it("uses APISIX OIDC, Redis-backed limits, and fail-closed OPA decisions on protected routes", () => {
    const apisix = read("infra/apisix/apisix.yaml");
    expect(apisix).toContain("openid-connect:");
    expect(apisix).toContain("use_jwks: true");
    expect(apisix).toContain("limit-req:");
    expect(apisix).toContain("limit-conn:");
    expect(apisix).toContain("policy: redis");
    expect(apisix).toContain("allow_degradation: false");
    expect(apisix).toContain("policy: umojaflowos/gateway");
  });

  it("requires Keycloak MFA configuration and preserves OPA default-deny policy", () => {
    const keycloak = JSON.parse(read("infra/keycloak/realm-umojaflowos.json")) as { requiredActions: Array<{ alias: string; defaultAction: boolean }>; bruteForceProtected: boolean; revokeRefreshToken: boolean };
    const policy = read("infra/opa/umojaflowos_gateway.rego");
    expect(keycloak.bruteForceProtected).toBe(true);
    expect(keycloak.revokeRefreshToken).toBe(true);
    expect(keycloak.requiredActions).toContainEqual(expect.objectContaining({ alias: "CONFIGURE_TOTP", defaultAction: true }));
    expect(policy).toContain('default result := {"allow": false');
    expect(policy).toContain("has_privileged_role");
  });
});
