import { createHash, randomBytes } from "node:crypto";
import { parse as parseCookieHeader } from "cookie";
import type { Express, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import type { PlatformIdentity } from "../identity";
import { COOKIE_NAME } from "@shared/const";

const OIDC_TRANSACTION_COOKIE = "__Host-umoja-oidc";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const TRANSACTION_TTL_SECONDS = 10 * 60;

type OidcConfiguration = { issuer: URL; clientId: string; clientSecret: string | null; audience: string; publicBaseUrl: URL };
type Transaction = { state: string; nonce: string; verifier: string; returnTo: string };

function base64url(bytes: Buffer): string { return bytes.toString("base64url"); }
function secret(): Uint8Array {
  const value = process.env.UMOJA_SESSION_SECRET;
  if (!value || value.length < 32) throw new Error("UMOJA_SESSION_SECRET must contain at least 32 characters");
  return new TextEncoder().encode(value);
}
function configuration(): OidcConfiguration | null {
  const rawIssuer = process.env.UMOJA_KEYCLOAK_ISSUER;
  const clientId = process.env.UMOJA_KEYCLOAK_CLIENT_ID;
  const audience = process.env.UMOJA_KEYCLOAK_AUDIENCE ?? clientId;
  const rawBaseUrl = process.env.UMOJA_PUBLIC_BASE_URL;
  if (!rawIssuer || !clientId || !audience || !rawBaseUrl) return null;
  try {
    const issuer = new URL(rawIssuer);
    const publicBaseUrl = new URL(rawBaseUrl);
    const localDev = publicBaseUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(publicBaseUrl.hostname);
    if ((issuer.protocol !== "https:" && !(localDev && issuer.protocol === "http:")) || (publicBaseUrl.protocol !== "https:" && !localDev)) return null;
    if (issuer.username || issuer.password || issuer.search || issuer.hash || publicBaseUrl.username || publicBaseUrl.password || publicBaseUrl.search || publicBaseUrl.hash) return null;
    return { issuer, clientId, clientSecret: process.env.UMOJA_KEYCLOAK_CLIENT_SECRET ?? null, audience, publicBaseUrl };
  } catch { return null; }
}
function cookieOptions(secure: boolean) { return { httpOnly: true, secure, sameSite: "lax" as const, path: "/" }; }
function redirectUri(config: OidcConfiguration) { return new URL("/auth/callback", config.publicBaseUrl).toString(); }
function platformUser(subject: string, name: unknown, email: unknown): PlatformIdentity {
  const now = new Date();
  return { id: 0, openId: `kc_${createHash("sha256").update(subject).digest("hex").slice(0, 61)}`, name: typeof name === "string" ? name.slice(0, 500) : null, email: typeof email === "string" && email.length <= 320 ? email : null, loginMethod: "keycloak", role: "auditor", createdAt: now, updatedAt: now, lastSignedIn: now };
}
async function sign(value: Record<string, unknown>, expiresIn: number): Promise<string> {
  return new SignJWT(value).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setIssuedAt().setExpirationTime(`${expiresIn}s`).sign(secret());
}
async function verify<T extends Record<string, unknown>>(token: string | undefined): Promise<T | null> {
  if (!token) return null;
  try { return (await jwtVerify(token, secret(), { algorithms: ["HS256"] })).payload as T; } catch { return null; }
}
function safeReturnTo(value: string | undefined): string { return value?.startsWith("/") && !value.startsWith("//") ? value : "/console"; }

export async function authenticateSession(request: Request): Promise<PlatformIdentity | null> {
  const token = parseCookieHeader(request.headers.cookie ?? "")[COOKIE_NAME];
  const claims = await verify<{ openId?: string; name?: string; email?: string; loginMethod?: string }>(token);
  if (!claims?.openId) return null;
  const now = new Date();
  return { id: 0, openId: claims.openId, name: typeof claims.name === "string" ? claims.name : null, email: typeof claims.email === "string" ? claims.email : null, loginMethod: typeof claims.loginMethod === "string" ? claims.loginMethod : "keycloak", role: "auditor", createdAt: now, updatedAt: now, lastSignedIn: now };
}

export function registerOidcRoutes(app: Express) {
  app.get("/auth/login", async (req, res) => {
    const config = configuration();
    if (!config) return res.status(503).json({ error: "identity provider is not configured" });
    const transaction: Transaction = { state: base64url(randomBytes(32)), nonce: base64url(randomBytes(32)), verifier: base64url(randomBytes(64)), returnTo: safeReturnTo(typeof req.query.returnTo === "string" ? req.query.returnTo : undefined) };
    const challenge = createHash("sha256").update(transaction.verifier).digest("base64url");
    const auth = new URL("protocol/openid-connect/auth", `${config.issuer.toString().replace(/\/$/, "")}/`);
    auth.searchParams.set("client_id", config.clientId);
    auth.searchParams.set("redirect_uri", redirectUri(config));
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", "openid profile email");
    auth.searchParams.set("state", transaction.state);
    auth.searchParams.set("nonce", transaction.nonce);
    auth.searchParams.set("code_challenge", challenge);
    auth.searchParams.set("code_challenge_method", "S256");
    res.cookie(OIDC_TRANSACTION_COOKIE, await sign(transaction, TRANSACTION_TTL_SECONDS), { ...cookieOptions(config.publicBaseUrl.protocol === "https:"), maxAge: TRANSACTION_TTL_SECONDS * 1000 });
    res.redirect(302, auth.toString());
  });
  app.get("/auth/callback", async (req, res) => {
    const config = configuration();
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    const transactionToken = parseCookieHeader(req.headers.cookie ?? "")[OIDC_TRANSACTION_COOKIE];
    const transaction = await verify<Transaction>(transactionToken);
    res.clearCookie(OIDC_TRANSACTION_COOKIE, cookieOptions(config?.publicBaseUrl.protocol === "https:"));
    if (!config || !code || !state || !transaction || state !== transaction.state) return res.status(403).json({ error: "invalid OIDC login transaction" });
    try {
      const tokenUrl = new URL("protocol/openid-connect/token", `${config.issuer.toString().replace(/\/$/, "")}/`);
      const form = new URLSearchParams({ grant_type: "authorization_code", client_id: config.clientId, code, redirect_uri: redirectUri(config), code_verifier: transaction.verifier });
      if (config.clientSecret) form.set("client_secret", config.clientSecret);
      const response = await fetch(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error("token exchange rejected");
      const tokens = await response.json() as { id_token?: string };
      if (!tokens.id_token) throw new Error("identity token missing");
      const jwks = createRemoteJWKSet(new URL("protocol/openid-connect/certs", `${config.issuer.toString().replace(/\/$/, "")}/`));
      const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: config.issuer.toString().replace(/\/$/, ""), audience: config.audience });
      if (payload.nonce !== transaction.nonce || typeof payload.sub !== "string" || !payload.sub) throw new Error("identity token validation failed");
      const user = platformUser(payload.sub, payload.name, payload.email);
      res.cookie(COOKIE_NAME, await sign({ openId: user.openId, name: user.name ?? "", email: user.email ?? "", loginMethod: "keycloak" }, SESSION_TTL_SECONDS), { ...cookieOptions(config.publicBaseUrl.protocol === "https:"), maxAge: SESSION_TTL_SECONDS * 1000 });
      res.redirect(302, transaction.returnTo);
    } catch { res.status(401).json({ error: "identity verification failed" }); }
  });
  app.post("/auth/logout", (_req, res) => { res.clearCookie(COOKIE_NAME, cookieOptions(process.env.NODE_ENV === "production")); res.status(204).end(); });
}
