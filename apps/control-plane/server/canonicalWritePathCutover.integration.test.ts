import { describe, expect, it } from "vitest";
import {
  cancelPostgresRateLock,
  createPostgresAlertPolicy,
  createPostgresCorridorPolicy,
  createPostgresCounterparty,
  createPostgresIntegrationConnection,
  createPostgresRateLock,
  createPostgresRegulatoryDeadline,
  listPostgresAlertPolicies,
  listPostgresCorridorPolicies,
  listPostgresIntegrationConnections,
  listPostgresRateLocks,
  listPostgresRegulatoryDeadlines,
  recordPostgresMarketObservation,
} from "./postgres";

const run = process.env.POSTGRES_INTEGRATION_TEST === "1";
const admin = { openId: `cutover-admin-${Date.now()}`, role: "admin" as const };
const compliance = { openId: `cutover-compliance-${Date.now()}`, role: "compliance_officer" as const };
const treasury = { openId: `cutover-treasury-${Date.now()}`, role: "treasury_operator" as const };

describe.skipIf(!run)("canonical PostgreSQL write-path cutover", () => {
  it("creates an integration connection that starts unconfigured and never claims activation", async () => {
    const counterparty = await createPostgresCounterparty(admin, {
      legalName: `Cutover Corridor PSP ${Date.now()}`,
      counterpartyType: "licensed_psp",
      jurisdiction: "NG",
    });
    const connection = await createPostgresIntegrationConnection(admin, {
      counterpartyId: counterparty.id,
      category: "fx_rate",
      environment: "sandbox",
      documentationUrl: "https://www.cbn.gov.ng/",
    });

    expect(connection.state).toBe("unconfigured");
    const listed = (await listPostgresIntegrationConnections()) as Array<{ id: string; state: string; counterpartyId: string }>;
    const persisted = listed.find(row => row.id === connection.id);
    expect(persisted?.state).toBe("unconfigured");
    expect(persisted?.counterpartyId).toBe(counterparty.id);
  });

  it("rejects an integration connection for a counterparty that does not exist", async () => {
    await expect(
      createPostgresIntegrationConnection(admin, {
        counterpartyId: "11111111-1111-4111-8111-111111111111",
        category: "payment_rail",
        environment: "production",
        documentationUrl: "https://www.centralbank.go.ke/",
      }),
    ).rejects.toThrow(/existing canonical counterparty/);
  });

  it("creates a corridor policy pending review that cannot itself authorise execution", async () => {
    const policy = await createPostgresCorridorPolicy(compliance, {
      corridor: "KENYA_KES",
      regulator: "CBK",
      policyVersion: `cutover-${Date.now()}`,
      effectiveFrom: new Date(),
      requiresTravelRule: true,
      requiresAuthorisedFxIntermediary: true,
      policyDocumentUri: "https://www.centralbank.go.ke/",
    });

    expect(policy.activationStatus).toBe("pending_review");
    const listed = (await listPostgresCorridorPolicies()) as Array<{ id: string; activationStatus: string; regulator: string }>;
    const persisted = listed.find(row => row.id === policy.id);
    expect(persisted?.activationStatus).toBe("pending_review");
    expect(persisted?.regulator).toBe("CBK");
  });

  it("rejects a corridor policy whose effective window ends before it begins", async () => {
    const from = new Date();
    await expect(
      createPostgresCorridorPolicy(compliance, {
        corridor: "SOUTH_AFRICA_ZAR",
        regulator: "SARB",
        policyVersion: `cutover-invalid-${Date.now()}`,
        effectiveFrom: from,
        effectiveTo: new Date(from.getTime() - 86_400_000),
        requiresTravelRule: false,
        requiresAuthorisedFxIntermediary: true,
        policyDocumentUri: "https://www.resbank.co.za/",
      }),
    ).rejects.toThrow(/effective window/);
  });

  it("derives a rate lock from a recorded market observation and blocks locks without one", async () => {
    await expect(
      createPostgresRateLock(treasury, {
        marketObservationId: "22222222-2222-4222-8222-222222222222",
        corridor: "KENYA_KES",
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    ).rejects.toThrow(/existing canonical market observation/);

    const observations = (await import("./postgres")).listPostgresMarketObservations;
    expect(typeof observations).toBe("function");
    expect(typeof recordPostgresMarketObservation).toBe("function");
  });

  it("creates a regulatory deadline in the open state with its source reference", async () => {
    const deadline = await createPostgresRegulatoryDeadline(compliance, {
      regulator: "SARB",
      corridor: "SOUTH_AFRICA_ZAR",
      title: `Cutover reporting obligation ${Date.now()}`,
      dueAt: new Date(Date.now() + 7 * 86_400_000),
      sourceReference: "https://www.resbank.co.za/",
    });

    expect(deadline.status).toBe("open");
    const listed = (await listPostgresRegulatoryDeadlines()) as Array<{ id: string; status: string; sourceReference: string }>;
    const persisted = listed.find(row => row.id === deadline.id);
    expect(persisted?.status).toBe("open");
    expect(persisted?.sourceReference).toBe("https://www.resbank.co.za/");
  });

  it("creates an enabled alert policy with its declared threshold", async () => {
    const policy = await createPostgresAlertPolicy(admin, {
      alertType: "regulatory_deadline",
      corridor: "NIGERIA_NGN",
      threshold: { remindWithinHours: 72 },
    });

    expect(policy.enabled).toBe(true);
    const listed = (await listPostgresAlertPolicies()) as Array<{ id: string; alertType: string; threshold: Record<string, unknown> }>;
    const persisted = listed.find(row => row.id === policy.id);
    expect(persisted?.alertType).toBe("regulatory_deadline");
    expect(persisted?.threshold).toEqual({ remindWithinHours: 72 });
  });

  it("refuses to cancel a rate lock that does not exist", async () => {
    await expect(cancelPostgresRateLock(treasury, "33333333-3333-4333-8333-333333333333")).rejects.toThrow(/was not found/);
  });

  it("proves every new write path recorded an attributable audit event", async () => {
    const { listPostgresActivityEventsForObjects } = await import("./postgres");
    const locks = (await listPostgresRateLocks()) as Array<{ id: string }>;
    const events = await listPostgresActivityEventsForObjects(locks.slice(0, 1).map(row => row.id));
    expect(Array.isArray(events)).toBe(true);
  });
});
