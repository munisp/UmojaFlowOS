import { afterAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { closePostgresPool, listPostgresActivityEventsForObjects } from "./postgres";

const runIntegration = process.env.POSTGRES_INTEGRATION_TEST === "1";

function contextFor(role: "admin" | "compliance_officer" | "treasury_operator" | "auditor", openId: string): TrpcContext {
  return {
    user: {
      id: 91,
      openId,
      name: `${role} operator`,
      email: `${openId}@example.com`,
      loginMethod: "keycloak",
      role,
      createdAt: new Date("2026-08-18T00:00:00.000Z"),
      updatedAt: new Date("2026-08-18T00:00:00.000Z"),
      lastSignedIn: new Date("2026-08-18T00:00:00.000Z"),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
    pendingIdentity: null,
  };
}

describe.skipIf(!runIntegration)("counterparty licence authorisation lifecycle", () => {
  afterAll(async () => {
    await closePostgresPool();
  });

  it("keeps licence lifecycle transitions administrator-only, persisted, and auditor-visible", async () => {
    const administrator = appRouter.createCaller(contextFor("admin", `registry-admin-${Date.now()}`));
    const counterparty = await administrator.postgres.createCounterparty({
      legalName: `Registry Regression PSP ${Date.now()}`,
      counterpartyType: "licensed_psp",
      jurisdiction: "Nigeria",
    });

    const authorization = await administrator.postgres.createCounterpartyAuthorization({
      counterpartyId: counterparty.id,
      regulator: "CBN",
      licenceReference: `CBN-REG-${Date.now()}`,
      scopeDescription: "Cross-border payment collection and payout scope evidenced by the supplied licence record.",
      evidenceUri: "s3://umojaflowos-licence-evidence/cbn/registry-regression.pdf",
      validFrom: new Date("2026-01-01T00:00:00.000Z"),
      status: "pending_review",
    });

    for (const role of ["auditor", "compliance_officer", "treasury_operator"] as const) {
      const caller = appRouter.createCaller(contextFor(role, `registry-${role}-${Date.now()}`));
      await expect(caller.postgres.transitionCounterpartyAuthorization({ authorizationId: authorization.id, status: "verified" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }

    const verified = await administrator.postgres.transitionCounterpartyAuthorization({ authorizationId: authorization.id, status: "verified" });
    expect(verified.status).toBe("verified");

    const visibleToAuditor = await appRouter
      .createCaller(contextFor("auditor", `registry-auditor-read-${Date.now()}`))
      .postgres.counterpartyAuthorizations();
    const persisted = visibleToAuditor.find(record => record.id === authorization.id);
    expect(persisted?.status).toBe("verified");
    expect(persisted?.verifiedAt).toBeTruthy();
    expect(persisted?.counterpartyId).toBe(counterparty.id);

    await expect(administrator.postgres.transitionCounterpartyAuthorization({ authorizationId: authorization.id, status: "verified" })).rejects.toThrow(/invalid counterparty authorization lifecycle transition/);

    const events = await listPostgresActivityEventsForObjects([authorization.id]);
    const transition = events.find(event => event.action === "counterparty_authorization.transitioned");
    expect(transition?.actorRole).toBe("admin");
    expect((transition?.metadata as { from: string; to: string })).toMatchObject({ from: "pending_review", to: "verified" });
  });
});
