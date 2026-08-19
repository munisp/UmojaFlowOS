import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { beginCounterpartyRecertification, createCounterpartyOnboarding, decideCounterpartyOnboardingGate } from "./counterpartyOnboarding";
import {
  closePostgresPool,
  createPostgresCounterparty,
  createPostgresCounterpartyAuthorization,
  createPostgresIntegrationConnection,
  getPool,
  transitionPostgresCounterpartyAuthorization,
} from "./postgres";

const admin = { openId: `onboarding-admin-${crypto.randomUUID()}`, role: "admin" as const };
const compliance = { openId: `onboarding-compliance-${crypto.randomUUID()}`, role: "compliance_officer" as const };
const treasury = { openId: `onboarding-treasury-${crypto.randomUUID()}`, role: "treasury_operator" as const };

async function fixture() {
  const counterparty = await createPostgresCounterparty(admin, {
    legalName: `Boundary Regression Onboarding ${crypto.randomUUID().slice(0, 8)}`,
    counterpartyType: "stablecoin_provider",
    jurisdiction: "Nigeria",
  });
  const authorization = await createPostgresCounterpartyAuthorization(admin, {
    counterpartyId: counterparty.id,
    regulator: "CBN",
    licenceReference: `licence-${crypto.randomUUID()}`,
    scopeDescription: "Stablecoin market-data and custody due diligence scope.",
    evidenceUri: "https://evidence.example.test/licence",
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    status: "pending_review",
  });
  await transitionPostgresCounterpartyAuthorization(admin, { authorizationId: authorization.id, status: "verified" });
  const onboarding = await createCounterpartyOnboarding(admin, {
    counterpartyId: counterparty.id,
    countryOverlays: ["NIGERIA_NGN"],
    legalEvidenceUri: "https://evidence.example.test/legal",
    recertificationDueAt: new Date("2027-01-01T00:00:00.000Z"),
  });
  if (!onboarding) throw new Error("onboarding fixture was not created");
  return { counterparty, onboarding };
}

async function enableFixtureIntegration(counterpartyId: string) {
  const integration = await createPostgresIntegrationConnection(admin, {
    counterpartyId,
    category: "stablecoin_market_data",
    environment: "sandbox",
    documentationUrl: "https://provider.example.test/docs",
  });
  // This is a schema-owner fixture to prove the onboarding gate requires an
  // already verified active connection; it does not exercise provider activation.
  await getPool().query("UPDATE integration_connections SET state='active' WHERE id=$1", [integration.id]);
}

describe("canonical counterparty onboarding lifecycle", () => {
  it("requires a verified legal gate, then a verified technical connection, and two independent pilot decisions", async () => {
    const { counterparty, onboarding } = await fixture();
    const legal = await decideCounterpartyOnboardingGate(compliance, {
      onboardingId: onboarding.id,
      gate: "legal",
      decision: "approved",
      evidenceUri: "https://evidence.example.test/legal-review",
      rationale: "Licence and ownership evidence are complete for the required corridor.",
    });
    expect(legal?.stage).toBe("technical_readiness");

    await expect(
      decideCounterpartyOnboardingGate(admin, {
        onboardingId: onboarding.id,
        gate: "technical",
        decision: "approved",
        evidenceUri: "https://evidence.example.test/technical",
        rationale: "Attempt before a health-verified integration is intentionally refused.",
      }),
    ).rejects.toThrow(/verified active integration/);

    await enableFixtureIntegration(counterparty.id);
    const technical = await decideCounterpartyOnboardingGate(admin, {
      onboardingId: onboarding.id,
      gate: "technical",
      decision: "approved",
      evidenceUri: "https://evidence.example.test/technical",
      rationale: "Sandbox readiness evidence records successful configured connection verification.",
    });
    expect(technical?.stage).toBe("pilot");

    const firstPilotApproval = await decideCounterpartyOnboardingGate(compliance, {
      onboardingId: onboarding.id,
      gate: "pilot",
      decision: "approved",
      evidenceUri: "https://evidence.example.test/pilot-compliance",
      rationale: "Pilot compliance review found no unresolved corridor control exception.",
    });
    expect(firstPilotApproval?.stage).toBe("pilot");

    const steadyState = await decideCounterpartyOnboardingGate(treasury, {
      onboardingId: onboarding.id,
      gate: "pilot",
      decision: "approved",
      evidenceUri: "https://evidence.example.test/pilot-treasury",
      rationale: "Pilot settlement and liquidity evidence are acceptable for steady-state consideration.",
    });
    expect(steadyState?.stage).toBe("steady_state");
    expect(steadyState?.decisions.filter(decision => decision.gate === "pilot" && decision.decision === "approved")).toHaveLength(2);
  });

  it("requires distinct actors for pilot approval and restarts a due recertification at legal onboarding", async () => {
    const { counterparty, onboarding } = await fixture();
    await decideCounterpartyOnboardingGate(compliance, {
      onboardingId: onboarding.id,
      gate: "legal",
      decision: "approved",
      evidenceUri: "https://evidence.example.test/legal-review-2",
      rationale: "Legal evidence is complete for the recertification lifecycle fixture.",
    });
    await enableFixtureIntegration(counterparty.id);
    await decideCounterpartyOnboardingGate(admin, {
      onboardingId: onboarding.id,
      gate: "technical",
      decision: "approved",
      evidenceUri: "https://evidence.example.test/technical-2",
      rationale: "Technical gate is satisfied by the active integration fixture.",
    });
    await decideCounterpartyOnboardingGate(compliance, {
      onboardingId: onboarding.id,
      gate: "pilot",
      decision: "approved",
      evidenceUri: "https://evidence.example.test/pilot-compliance-2",
      rationale: "First pilot decision is recorded by the compliance reviewer.",
    });
    await expect(
      decideCounterpartyOnboardingGate({ ...treasury, openId: compliance.openId }, {
        onboardingId: onboarding.id,
        gate: "pilot",
        decision: "approved",
        evidenceUri: "https://evidence.example.test/pilot-not-independent",
        rationale: "Same subject under a different role must not satisfy rule-of-two.",
      }),
    ).rejects.toThrow(/independent second actor/);
    await decideCounterpartyOnboardingGate(treasury, {
      onboardingId: onboarding.id,
      gate: "pilot",
      decision: "approved",
      evidenceUri: "https://evidence.example.test/pilot-treasury-2",
      rationale: "Second independent pilot decision is recorded by treasury.",
    });

    await getPool().query("UPDATE counterparty_onboardings SET recertification_due_at=now() - interval '1 minute' WHERE id=$1", [onboarding.id]);
    const recertification = await beginCounterpartyRecertification(compliance, onboarding.id, "https://evidence.example.test/recertification", new Date("2028-01-01T00:00:00.000Z"));
    expect(recertification?.stage).toBe("legal_onboarding");
    expect(recertification?.cycleNumber).toBe(2);
    expect(recertification?.technicalEvidenceUri).toBeNull();
    expect(recertification?.pilotEvidenceUri).toBeNull();
  });
});

afterAll(async () => {
  // The application role intentionally cannot delete append-only gate evidence.
  // Regression cleanup therefore runs under the schema owner with a fixed,
  // non-user-controlled predicate, mirroring the repository purge script.
  execFileSync("sudo", ["-u", "postgres", "psql", "-q", "-d", "umojaflowos_dev", "-c", `
    DELETE FROM counterparty_onboarding_gate_decisions WHERE onboarding_id IN (SELECT id FROM counterparty_onboardings WHERE created_by LIKE 'onboarding-admin-%');
    DELETE FROM counterparty_onboardings WHERE created_by LIKE 'onboarding-admin-%';
    DELETE FROM integration_connections WHERE counterparty_id IN (SELECT id FROM counterparties WHERE legal_name LIKE 'Boundary Regression Onboarding %');
    DELETE FROM counterparty_authorizations WHERE counterparty_id IN (SELECT id FROM counterparties WHERE legal_name LIKE 'Boundary Regression Onboarding %');
    DELETE FROM counterparties WHERE legal_name LIKE 'Boundary Regression Onboarding %';
  `]);
  await closePostgresPool();
});
