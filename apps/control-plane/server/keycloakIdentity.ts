import { createHash } from "node:crypto";

// The local identity column is capped at 64 characters. A fixed namespaced
// hash is stable, fits the column, and avoids persisting the identity
// provider's raw subject outside its dedicated identity system. Every path
// that turns a Keycloak subject into this platform's identity — the OIDC
// session callback, the bearer-token federation fallback, and admin-driven
// account creation — must derive the exact same value or the same person
// resolves to different, disconnected identities depending on how they got in.
export function deriveOpenId(subject: string): string {
  return `kc_${createHash("sha256").update(subject).digest("hex").slice(0, 61)}`;
}
