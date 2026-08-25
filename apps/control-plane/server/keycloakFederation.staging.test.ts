import { describe, expect, it } from "vitest";
import { resolveKeycloakUser } from "./keycloakFederation";

function stagingRequest(token: string, issuer: string): { header(name: string): string | undefined } {
  return {
    header(name: string) {
      if (name.toLowerCase() === "x-umoja-identity-provider") return "keycloak";
      if (name.toLowerCase() === "authorization") return `Bearer ${token}`;
      if (name.toLowerCase() === "x-umoja-keycloak-issuer") return issuer;
      return undefined;
    },
  };
}

describe("real Keycloak staging federation", () => {
  it("validates discovery, JWKS, issuer, audience, role, and MFA through the middleware", async () => {
    if (process.env.KEYCLOAK_STAGING_INTEGRATION !== "true") {
      return;
    }
    if (process.env.KEYCLOAK_STAGING_APPROVED !== "true") {
      throw new Error("refusing Keycloak staging test without KEYCLOAK_STAGING_APPROVED=true");
    }

    const issuer = process.env.UMOJA_KEYCLOAK_ISSUER?.trim();
    const audience = process.env.UMOJA_KEYCLOAK_AUDIENCE?.trim();
    const token = process.env.KEYCLOAK_STAGING_BEARER_TOKEN?.trim();
    if (!issuer || !audience || !token) {
      throw new Error("staging issuer, audience, and bearer token are required");
    }

    process.env.UMOJA_KEYCLOAK_ISSUER = issuer;
    process.env.UMOJA_KEYCLOAK_AUDIENCE = audience;
    process.env.UMOJA_KEYCLOAK_ALLOW_INSECURE_LOOPBACK = "false";

    const discovery = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    expect(discovery.ok).toBe(true);
    const metadata = await discovery.json() as { issuer?: string; jwks_uri?: string };
    expect(metadata.issuer?.replace(/\/$/, "")).toBe(issuer.replace(/\/$/, ""));
    expect(metadata.jwks_uri).toBe(`${issuer.replace(/\/$/, "")}/protocol/openid-connect/certs`);

    const jwks = await fetch(metadata.jwks_uri);
    expect(jwks.ok).toBe(true);
    const keySet = await jwks.json() as { keys?: unknown[] };
    expect(Array.isArray(keySet.keys)).toBe(true);
    expect(keySet.keys?.length).toBeGreaterThan(0);

    const identity = await resolveKeycloakUser(
      stagingRequest(token, issuer) as never,
    );
    expect(identity?.loginMethod).toBe("keycloak");
    expect(["admin", "compliance_officer", "treasury_operator", "auditor"]).toContain(identity?.role);
    expect(identity?.openId).toMatch(/^kc_[a-f0-9]{61}$/);
  }, 20_000);
});
