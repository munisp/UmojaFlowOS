import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { PlatformIdentity } from "../identity";
import { authenticateSession } from "./oidc";
import { resolveKeycloakUser } from "../keycloakFederation";
import { resolvePostgresOperatingRole, type PlatformUser } from "../postgresRoleResolver";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: PlatformUser | null;
};

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: PlatformIdentity | null = null;

  try {
    user = await authenticateSession(opts.req);
  } catch (error) {
    // Authentication is optional for public procedures.
    user = null;
  }

  // Keycloak federation is an explicit bearer-header flow that is verified
  // against the configured issuer's JWKS. It is a fallback, never a replacement
  // for an existing platform OAuth session.
  if (!user) {
    user = await resolveKeycloakUser(opts.req);
  }

  const resolvedUser = user ? await resolvePostgresOperatingRole(user) : null;
  return {
    req: opts.req,
    res: opts.res,
    user: resolvedUser,
  };
}
