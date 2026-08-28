import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { PlatformIdentity } from "../identity";
import { authenticateSession } from "./oidc";
import { resolveKeycloakUser } from "../keycloakFederation";
import { resolvePostgresOperatingRole, type PlatformUser } from "../postgresRoleResolver";
import { recordOperatorAccessAttempt } from "../operatorAccessRequests";

export type PendingIdentity = { subject: string; name: string | null; email: string | null };

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: PlatformUser | null;
  // Set only when the identity provider verified who the caller is but no
  // operating role has been granted yet, so the console can tell "not signed
  // in" apart from "signed in, waiting on an administrator" instead of
  // treating both the same way.
  pendingIdentity: PendingIdentity | null;
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
  let pendingIdentity: PendingIdentity | null = null;
  if (user && !resolvedUser) {
    pendingIdentity = { subject: user.openId, name: user.name, email: user.email };
    recordOperatorAccessAttempt(user.openId, user.name, user.email).catch(() => undefined);
  }
  return {
    req: opts.req,
    res: opts.res,
    user: resolvedUser,
    pendingIdentity,
  };
}
