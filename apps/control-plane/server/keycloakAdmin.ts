import { randomBytes } from "node:crypto";
import { deriveOpenId } from "./keycloakIdentity";

type AdminConfiguration = { issuer: URL; adminBaseUrl: URL; realm: string; clientId: string; clientSecret: string };

// A separate, narrowly-scoped credential from the login client: this one
// exists only to manage accounts through Keycloak's admin API, so it is
// configured independently and is never required for sign-in to function.
//
// adminBaseUrl deliberately can differ from the public OIDC issuer.
// `/admin/realms/*` (used for every REST call below) is a distinct surface
// from `/realms/*` (the OIDC endpoints), and it is common - by design, not
// by accident - for a deployment to expose only the latter publicly while
// keeping the admin API reachable exclusively on an internal network. A
// front door that proxies `/realms/*` is not obligated to proxy
// `/admin/*` too, so this must not be assumed. Falls back to deriving from
// the issuer for simpler deployments where the admin API is reachable at
// the same public host.
function adminConfiguration(): AdminConfiguration | null {
  const rawIssuer = process.env.UMOJA_KEYCLOAK_ISSUER;
  const clientId = process.env.UMOJA_KEYCLOAK_ADMIN_CLIENT_ID;
  const clientSecret = process.env.UMOJA_KEYCLOAK_ADMIN_CLIENT_SECRET;
  if (!rawIssuer || !clientId || !clientSecret) return null;
  try {
    const issuer = new URL(rawIssuer);
    const segments = issuer.pathname.split("/").filter(Boolean);
    const realm = segments[segments.length - 1];
    if (!realm) return null;
    const rawAdminBaseUrl = process.env.UMOJA_KEYCLOAK_ADMIN_BASE_URL;
    const adminBaseUrl = rawAdminBaseUrl ? new URL(rawAdminBaseUrl) : new URL(issuer.toString().replace(/\/realms\/[^/]+\/?$/, "/"));
    return { issuer, adminBaseUrl, realm, clientId, clientSecret };
  } catch { return null; }
}

export function operatorAccountCreationAvailable(): boolean {
  return adminConfiguration() !== null;
}

let cachedToken: { value: string; expiresAt: number } | null = null;

async function adminToken(config: AdminConfiguration): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const tokenUrl = new URL("protocol/openid-connect/token", `${config.issuer.toString().replace(/\/$/, "")}/`);
  const form = new URLSearchParams({ grant_type: "client_credentials", client_id: config.clientId, client_secret: config.clientSecret });
  const response = await fetch(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("identity provider rejected the admin service-account credential");
  const body = await response.json() as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("identity provider returned no admin access token");
  cachedToken = { value: body.access_token, expiresAt: Date.now() + Math.max(0, (body.expires_in ?? 60) - 10) * 1000 };
  return cachedToken.value;
}

function generatePassword(): string {
  return randomBytes(18).toString("base64url");
}

function usersEndpoint(config: AdminConfiguration): URL {
  return new URL(`admin/realms/${config.realm}/users`, config.adminBaseUrl);
}

export type KeycloakAccountSummary = { keycloakUserId: string; subject: string; name: string; email: string; enabled: boolean };

/**
 * Every account in the realm, for the operator directory. Keycloak is the
 * only place name/email/enabled state live — the app's internal `subject` is
 * a one-way hash of the Keycloak user id (deriveOpenId), so there is no way
 * to look this up starting from Postgres; enumeration has to start here.
 */
export async function listKeycloakAccounts(): Promise<KeycloakAccountSummary[]> {
  const config = adminConfiguration();
  if (!config) throw new Error("operator directory is not configured: UMOJA_KEYCLOAK_ADMIN_CLIENT_ID/SECRET are not set");
  const token = await adminToken(config);
  const url = usersEndpoint(config);
  url.searchParams.set("max", "1000");
  url.searchParams.set("briefRepresentation", "true");
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`identity provider rejected the account listing (status ${response.status})`);
  const body = await response.json() as Array<{ id: string; username: string; email?: string; firstName?: string; lastName?: string; enabled?: boolean }>;
  return body.map(user => ({
    keycloakUserId: user.id,
    subject: deriveOpenId(user.id),
    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username,
    email: user.email ?? user.username,
    enabled: user.enabled !== false,
  }));
}

/** Disables (or re-enables) sign-in for an account without deleting it — the account, its evidence authorship, and its audit trail all stay intact. */
export async function setKeycloakAccountEnabled(keycloakUserId: string, enabled: boolean): Promise<void> {
  const config = adminConfiguration();
  if (!config) throw new Error("operator directory is not configured: UMOJA_KEYCLOAK_ADMIN_CLIENT_ID/SECRET are not set");
  const token = await adminToken(config);
  const url = new URL(`${keycloakUserId}`, `${usersEndpoint(config).toString()}/`);
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ enabled }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`identity provider rejected the account ${enabled ? "activation" : "deactivation"} (status ${response.status})`);
}

export async function createOperatorAccount(input: { name: string; email: string }): Promise<{ subject: string; initialPassword: string }> {
  const config = adminConfiguration();
  if (!config) throw new Error("account creation is not configured: UMOJA_KEYCLOAK_ADMIN_CLIENT_ID/SECRET are not set");
  const token = await adminToken(config);
  const usersUrl = usersEndpoint(config);
  const password = generatePassword();
  const [firstName, ...rest] = input.name.trim().split(/\s+/);
  const createResponse = await fetch(usersUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      username: input.email,
      email: input.email,
      firstName: firstName || input.name,
      lastName: rest.join(" ") || undefined,
      enabled: true,
      emailVerified: true,
      requiredActions: [],
      credentials: [{ type: "password", value: password, temporary: false }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (createResponse.status === 409) throw new Error(`an identity provider account already exists for ${input.email}; this path only creates new accounts`);
  if (createResponse.status !== 201) throw new Error(`identity provider rejected account creation (status ${createResponse.status})`);
  const location = createResponse.headers.get("location");
  const subjectId = location?.split("/").pop();
  if (!subjectId) throw new Error("identity provider did not return the created account's identifier");
  return { subject: deriveOpenId(subjectId), initialPassword: password };
}
