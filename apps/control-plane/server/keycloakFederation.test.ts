import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Request } from "express";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { resolveKeycloakUser } from "./keycloakFederation";

const originalEnvironment = {
  issuer: process.env.UMOJA_KEYCLOAK_ISSUER,
  audience: process.env.UMOJA_KEYCLOAK_AUDIENCE,
  loopback: process.env.UMOJA_KEYCLOAK_ALLOW_INSECURE_LOOPBACK,
};

afterEach(() => {
  process.env.UMOJA_KEYCLOAK_ISSUER = originalEnvironment.issuer;
  process.env.UMOJA_KEYCLOAK_AUDIENCE = originalEnvironment.audience;
  process.env.UMOJA_KEYCLOAK_ALLOW_INSECURE_LOOPBACK = originalEnvironment.loopback;
});

function keycloakRequest(token: string | null): Request {
  return {
    header(name: string) {
      if (name === "x-umoja-identity-provider") return "keycloak";
      if (name === "authorization" && token) return `Bearer ${token}`;
      return undefined;
    },
  } as Request;
}

async function withJwksServer(
  run: (issuer: string, sign: (claims: Record<string, unknown>, audience?: string) => Promise<string>) => Promise<void>
) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "keycloak-regression-key";
  const server = createServer((request, response) => {
    if (request.url === "/realms/umojaflowos/protocol/openid-connect/certs") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const issuer = `http://127.0.0.1:${port}/realms/umojaflowos`;
  const sign = async (claims: Record<string, unknown>, audience = "umojaflowos-control-plane") =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "keycloak-regression-key" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("keycloak-subject-123")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  try {
    process.env.UMOJA_KEYCLOAK_ISSUER = issuer;
    process.env.UMOJA_KEYCLOAK_AUDIENCE = "umojaflowos-control-plane";
    process.env.UMOJA_KEYCLOAK_ALLOW_INSECURE_LOOPBACK = "true";
    await run(issuer, sign);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
}

describe("Keycloak federation", () => {
  it("accepts exactly one verified Keycloak platform role from a live JWKS endpoint", async () => {
    await withJwksServer(async (_issuer, sign) => {
      const token = await sign({
        name: "Amina Compliance",
        email: "amina@example.test",
        amr: ["pwd", "otp"],
        realm_access: { roles: ["offline_access", "umojaflowos_compliance_officer"] },
      });
      const user = await resolveKeycloakUser(keycloakRequest(token));
      expect(user?.loginMethod).toBe("keycloak");
      expect(user?.role).toBe("compliance_officer");
      expect(user?.openId).toMatch(/^kc_[a-f0-9]{61}$/);
      expect(user?.email).toBe("amina@example.test");
    });
  });

  it("refuses an invalid audience, a signature from another key, and ambiguous authority", async () => {
    await withJwksServer(async (_issuer, sign) => {
      const nonMfa = await sign({ realm_access: { roles: ["umojaflowos_auditor"] } });
      expect(await resolveKeycloakUser(keycloakRequest(nonMfa))).toBeNull();
      const wrongAudience = await sign({ realm_access: { roles: ["umojaflowos_auditor"] } }, "another-client");
      expect(await resolveKeycloakUser(keycloakRequest(wrongAudience))).toBeNull();

      const { privateKey } = await generateKeyPair("RS256");
      const forged = await new SignJWT({ realm_access: { roles: ["umojaflowos_admin"] } })
        .setProtectedHeader({ alg: "RS256", kid: "untrusted-key" })
        .setIssuer(process.env.UMOJA_KEYCLOAK_ISSUER!)
        .setAudience("umojaflowos-control-plane")
        .setSubject("forged")
        .setExpirationTime("5m")
        .sign(privateKey);
      expect(await resolveKeycloakUser(keycloakRequest(forged))).toBeNull();

      const ambiguous = await sign({ realm_access: { roles: ["umojaflowos_admin", "umojaflowos_auditor"] } });
      expect(await resolveKeycloakUser(keycloakRequest(ambiguous))).toBeNull();
    });
  });

  it("does not contact an issuer unless the request explicitly selects Keycloak", async () => {
    process.env.UMOJA_KEYCLOAK_ISSUER = "http://127.0.0.1:1/realms/umojaflowos";
    process.env.UMOJA_KEYCLOAK_AUDIENCE = "umojaflowos-control-plane";
    process.env.UMOJA_KEYCLOAK_ALLOW_INSECURE_LOOPBACK = "true";
    const request = { header: () => undefined } as Request;
    expect(await resolveKeycloakUser(request)).toBeNull();
  });
});
