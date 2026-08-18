export type OperatingRole = "admin" | "compliance_officer" | "treasury_operator" | "auditor";

const allowedRoles = new Set<OperatingRole>(["admin", "compliance_officer", "treasury_operator", "auditor"]);

export type KeycloakClaims = { sub?: unknown; preferred_username?: unknown; email?: unknown; realm_access?: { roles?: unknown } };

export function mapKeycloakClaims(claims: KeycloakClaims): { subject: string; username: string | null; email: string | null; roles: OperatingRole[] } {
  if (typeof claims.sub !== "string" || claims.sub.trim() === "") throw new Error("Keycloak subject claim is required");
  const rawRoles = Array.isArray(claims.realm_access?.roles) ? claims.realm_access?.roles : [];
  const roles = rawRoles.filter((role): role is OperatingRole => typeof role === "string" && allowedRoles.has(role as OperatingRole));
  return { subject: claims.sub, username: typeof claims.preferred_username === "string" ? claims.preferred_username : null, email: typeof claims.email === "string" ? claims.email : null, roles };
}

export function requireKeycloakRole(claims: KeycloakClaims, role: OperatingRole) {
  const identity = mapKeycloakClaims(claims);
  if (!identity.roles.includes(role)) throw new Error("Keycloak role is not authorized");
  return identity;
}
