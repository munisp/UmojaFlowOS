import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";

function caller(role: string) {
  return appRouter.createCaller({
    user: { openId: `onboarding-rbac-${role}`, role, name: role, email: `${role}@example.com` },
    req: {} as never,
    res: { cookie: () => undefined, clearCookie: () => undefined } as never,
  } as never);
}

const ID = "00000000-0000-0000-0000-000000000000";
const decision = { onboardingId: ID, decision: "approved" as const, evidenceUri: "https://evidence.example/record", rationale: "Independent recorded review of the required evidence." };

describe("counterparty onboarding access control", () => {
  it("keeps the lifecycle read auditor-readable", async () => {
    const client = caller("auditor");
    await expect(client.postgres.counterpartyOnboardings()).resolves.toBeDefined();
  });

  it.each(["compliance_officer", "treasury_operator", "auditor"] as const)("refuses onboarding creation for %s", async role => {
    const client = caller(role) as unknown as Record<string, Record<string, (input: unknown) => Promise<unknown>>>;
    await expect(client.postgres.createCounterpartyOnboarding({ counterpartyId: ID, countryOverlays: ["NIGERIA_NGN"], legalEvidenceUri: "https://evidence.example/legal", recertificationDueAt: new Date("2030-01-01T00:00:00Z") })).rejects.toThrow(/permission|FORBIDDEN|denied/i);
  });

  it.each(["admin", "treasury_operator", "auditor"] as const)("refuses the compliance-only legal and pilot gate procedure for %s", async role => {
    const client = caller(role) as unknown as Record<string, Record<string, (input: unknown) => Promise<unknown>>>;
    await expect(client.postgres.decideCounterpartyOnboardingGate({ ...decision, gate: "legal" })).rejects.toThrow(/permission|FORBIDDEN|denied/i);
  });

  it.each(["compliance_officer", "treasury_operator", "auditor"] as const)("refuses technical gate for %s", async role => {
    const client = caller(role) as unknown as Record<string, Record<string, (input: unknown) => Promise<unknown>>>;
    await expect(client.postgres.decideTechnicalOnboardingGate(decision)).rejects.toThrow(/permission|FORBIDDEN|denied/i);
  });

  it.each(["treasury_operator", "auditor"] as const)("refuses recertification for %s", async role => {
    const client = caller(role) as unknown as Record<string, Record<string, (input: unknown) => Promise<unknown>>>;
    await expect(client.postgres.beginCounterpartyRecertification({ onboardingId: ID, legalEvidenceUri: "https://evidence.example/renewal", recertificationDueAt: new Date("2030-01-01T00:00:00Z") })).rejects.toThrow(/permission|FORBIDDEN|denied/i);
  });

  it.each(["compliance_officer", "auditor"] as const)("refuses treasury pilot decision for %s", async role => {
    const client = caller(role) as unknown as Record<string, Record<string, (input: unknown) => Promise<unknown>>>;
    await expect(client.postgres.decideTreasuryPilotOnboardingGate(decision)).rejects.toThrow(/permission|FORBIDDEN|denied/i);
  });

  it("negative control: each assigned authority passes its role gate before record validation", async () => {
    const admin = caller("admin") as unknown as Record<string, Record<string, (input: unknown) => Promise<unknown>>>;
    const compliance = caller("compliance_officer") as unknown as Record<string, Record<string, (input: unknown) => Promise<unknown>>>;
    const treasury = caller("treasury_operator") as unknown as Record<string, Record<string, (input: unknown) => Promise<unknown>>>;

    await expect(admin.postgres.createCounterpartyOnboarding({ counterpartyId: ID, countryOverlays: ["NIGERIA_NGN"], legalEvidenceUri: "https://evidence.example/legal", recertificationDueAt: new Date("2030-01-01T00:00:00Z") })).rejects.toThrow(/counterparty|does not exist/i);
    await expect(compliance.postgres.decideCounterpartyOnboardingGate({ ...decision, gate: "legal" })).rejects.toThrow(/onboarding|does not exist/i);
    await expect(treasury.postgres.decideTreasuryPilotOnboardingGate(decision)).rejects.toThrow(/onboarding|does not exist/i);
    await expect(compliance.postgres.beginCounterpartyRecertification({ onboardingId: ID, legalEvidenceUri: "https://evidence.example/renewal", recertificationDueAt: new Date("2030-01-01T00:00:00Z") })).rejects.toThrow(/onboarding|does not exist/i);
  });
});
