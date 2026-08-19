import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";

/**
 * Credential configuration is the most consequential administrative action in
 * the platform, so its role gate is asserted directly rather than inherited by
 * assumption. A compliance officer or treasury operator obtaining the ability to
 * point an integration at a different provider would defeat the separation of
 * duties the rest of the system maintains.
 */
const NON_ADMIN_ROLES = ["compliance_officer", "treasury_operator", "auditor"] as const;

const CREDENTIAL_PROCEDURES = [
  "configureIntegrationCredential",
  "activateIntegrationConnection",
  "suspendIntegrationConnection",
  "integrationCredentialStatus",
] as const;

function caller(role: string) {
  return appRouter.createCaller({
    user: { openId: `subject-${role}`, role, name: role, email: `${role}@example.com` },
    req: {} as never,
    res: { cookie: () => undefined, clearCookie: () => undefined } as never,
  } as never);
}

const INPUTS: Record<string, unknown> = {
  configureIntegrationCredential: {
    integrationConnectionId: "00000000-0000-0000-0000-000000000000",
    secretReference: "PROVIDER_FX_API_KEY",
    endpointUrl: "https://provider.example.com/health",
  },
  activateIntegrationConnection: { integrationConnectionId: "00000000-0000-0000-0000-000000000000" },
  suspendIntegrationConnection: {
    integrationConnectionId: "00000000-0000-0000-0000-000000000000",
    reason: "rotating the provider credential",
  },
  integrationCredentialStatus: undefined,
};

describe("credential configuration access control", () => {
  it.each(NON_ADMIN_ROLES)("refuses every credential procedure for %s", async role => {
    for (const procedure of CREDENTIAL_PROCEDURES) {
      const client = caller(role) as unknown as Record<string, Record<string, (input?: unknown) => Promise<unknown>>>;
      await expect(
        client.postgres[procedure](INPUTS[procedure]),
      ).rejects.toThrow(/permission|FORBIDDEN|denied/i);
    }
  });

  it("refuses every credential procedure for an unauthenticated caller", async () => {
    const client = appRouter.createCaller({
      user: null,
      req: {} as never,
      res: { cookie: () => undefined, clearCookie: () => undefined } as never,
    } as never) as unknown as Record<string, Record<string, (input?: unknown) => Promise<unknown>>>;
    for (const procedure of CREDENTIAL_PROCEDURES) {
      await expect(client.postgres[procedure](INPUTS[procedure])).rejects.toThrow();
    }
  });

  it("negative control: an administrator is not refused by the role gate", async () => {
    // Without this, the assertions above would pass even if every procedure
    // were unconditionally broken.
    const client = caller("admin") as unknown as Record<string, Record<string, (input?: unknown) => Promise<unknown>>>;
    // The read succeeds outright for an administrator.
    await expect(client.postgres.integrationCredentialStatus()).resolves.toBeDefined();
    // The mutation fails on the missing record, not on the role, which proves
    // the caller passed the gate.
    await expect(
      client.postgres.configureIntegrationCredential(INPUTS.configureIntegrationCredential),
    ).rejects.toThrow(/does not exist/);
  });
});
