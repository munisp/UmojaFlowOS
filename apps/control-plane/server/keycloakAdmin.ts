import { randomBytes } from "node:crypto";
import { deriveOpenId } from "./keycloakIdentity";

type AdminConfiguration = { issuer: URL; realm: string; clientId: string; clientSecret: string };

// A separate, narrowly-scoped credential from the login client: this one
// exists only to create accounts through Keycloak's admin API, so it is
// configured independently and is never required for sign-in to function.
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
    return { issuer, realm, clientId, clientSecret };
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

export async function createOperatorAccount(input: { name: string; email: string }): Promise<{ subject: string; initialPassword: string }> {
  const config = adminConfiguration();
  if (!config) throw new Error("account creation is not configured: UMOJA_KEYCLOAK_ADMIN_CLIENT_ID/SECRET are not set");
  const token = await adminToken(config);
  const usersUrl = new URL(`admin/realms/${config.realm}/users`, `${config.issuer.toString().replace(/\/realms\/[^/]+\/?$/, "")}/`);
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
