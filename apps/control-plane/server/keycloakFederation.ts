import { createHash } from "node:crypto";
import type { Request } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { PlatformIdentity } from "./identity";

type PlatformRole = "admin" | "compliance_officer" | "treasury_operator" | "auditor";

const ROLE_BY_REALM_ROLE: Record<string, PlatformRole> = {
  umojaflowos_admin: "admin",
  umojaflowos_compliance_officer: "compliance_officer",
  umojaflowos_treasury_operator: "treasury_operator",
  umojaflowos_auditor: "auditor",
};

type KeycloakConfiguration = {
  issuer: URL;
  audience: string;
};

function loopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function configuredKeycloak(): KeycloakConfiguration | null {
  const rawIssuer = process.env.UMOJA_KEYCLOAK_ISSUER;
  const audience = process.env.UMOJA_KEYCLOAK_AUDIENCE;
  if (!rawIssuer || !audience) return null;
  let issuer: URL;
  try {
    issuer = new URL(rawIssuer);
  } catch {
    return null;
  }
  if (issuer.username || issuer.password || issuer.search || issuer.hash) return null;
  const allowInsecureLoopback = process.env.UMOJA_KEYCLOAK_ALLOW_INSECURE_LOOPBACK === "true";
  if (issuer.protocol === "https:") {
    // expected deployment transport
  } else if (issuer.protocol === "http:" && allowInsecureLoopback && loopbackHost(issuer.hostname)) {
    // explicit local development exception only
  } else {
    return null;
  }
  return { issuer, audience };
}

function authorizationToken(request: Request): string | null {
  // An explicit selector prevents unrelated bearer credentials from being sent
  // to the Keycloak JWKS verifier and avoids issuer probing on normal requests.
  if (request.header("x-umoja-identity-provider") !== "keycloak") return null;
  const header = request.header("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

function selectedRole(payload: JWTPayload): PlatformRole | null {
  const realmAccess = payload.realm_access;
  if (!realmAccess || typeof realmAccess !== "object" || !Array.isArray((realmAccess as { roles?: unknown }).roles)) {
    return null;
  }
  const roles = (realmAccess as { roles: unknown[] }).roles.filter((role): role is string => typeof role === "string");
  const selected = roles.map(role => ROLE_BY_REALM_ROLE[role]).filter((role): role is PlatformRole => Boolean(role));
  // A realm token that declares more than one platform authority is ambiguous;
  // the request must be resolved at the identity provider rather than allowing
  // the application to guess which role is intended.
  return selected.length === 1 ? selected[0] : null;
}

function federatedOpenId(subject: string): string {
  // The local identity column is capped at 64 characters. A fixed namespaced
  // hash is stable, fits the column, and avoids persisting the provider's raw
  // subject outside its dedicated identity system.
  return `kc_${createHash("sha256").update(subject).digest("hex").slice(0, 61)}`;
}

export async function resolveKeycloakUser(request: Request): Promise<PlatformIdentity | null> {
  const token = authorizationToken(request);
  const configuration = configuredKeycloak();
  if (!token || !configuration) return null;
  const jwks = createRemoteJWKSet(new URL("protocol/openid-connect/certs", `${configuration.issuer.toString().replace(/\/$/, "")}/`));
  try {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: configuration.issuer.toString().replace(/\/$/, ""),
      audience: configuration.audience,
    });
    const role = selectedRole(payload);
    const subject = typeof payload.sub === "string" && payload.sub.trim() ? payload.sub : null;
    if (!role || !subject) return null;
    const now = new Date();
    return {
      id: 0,
      openId: federatedOpenId(subject),
      name: typeof payload.name === "string" ? payload.name.slice(0, 500) : null,
      email: typeof payload.email === "string" && payload.email.length <= 320 ? payload.email : null,
      loginMethod: "keycloak",
      role,
      createdAt: now,
      updatedAt: now,
      lastSignedIn: now,
    };
  } catch {
    // Do not leak a claim, signature, issuer, or JWKS reason to the caller.
    // The normal authentication layer will treat this as unauthenticated.
    return null;
  }
}
