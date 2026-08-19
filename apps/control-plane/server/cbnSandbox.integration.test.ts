import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { createCbnSandboxDossier, createCbnSandboxReportingPack, createCbnSandboxTestPlan, getCbnSandboxReadiness, recordCbnSandboxEvidence, recordCbnSandboxIncident } from "./cbnSandbox";
import { registerPostgresLegalEntity } from "./legalEntityRegistry";
import { closePostgresPool, getPool } from "./postgres";

const run = process.env.POSTGRES_INTEGRATION_TEST === "1" ? describe : describe.skip;
const actor = { openId: `cbn-sandbox-admin-${crypto.randomUUID()}`, role: "admin" as const };
let entityId: string | undefined;
let dossierId: string | undefined;

run("CBN Cohort 2 sandbox readiness", () => {
  it("retains supplied readiness evidence and test controls while returning only a pending external-review state", async () => {
    const entity = await registerPostgresLegalEntity(actor, { legalName: `Boundary Regression CBN Sandbox ${crypto.randomUUID().slice(0, 8)}`, jurisdiction: "Nigeria", registrationIdentifier: `regression-cbn-${crypto.randomUUID()}` });
    entityId = entity.id;
    const dossier = await createCbnSandboxDossier(actor, { legalEntityId: entity.id, track: "vasp", productName: "NGN stablecoin controls", productSummary: "A provider-gated, evidence-only operating control plane for controlled Nigeria (NGN) stablecoin testing." });
    dossierId = dossier.id;
    await recordCbnSandboxEvidence(actor, { dossierId: dossier.id, category: "corporate_governance", evidenceUri: "https://evidence.example.test/corporate", evidenceSha256: "a".repeat(64) });
    await createCbnSandboxTestPlan(actor, { dossierId: dossier.id, permittedUse: "Controlled supervised evaluation of provider-gated Nigeria (NGN) payment readiness only.", userCategory: "Approved supervised pilot participants", maxTransactions: 100, maxAggregateExposure: "25000.00", startsAt: new Date("2026-09-01T00:00:00.000Z"), endsAt: new Date("2026-09-30T00:00:00.000Z"), successMetricsUri: "https://evidence.example.test/metrics", windDownUri: "https://evidence.example.test/wind-down" });
    const readiness = await getCbnSandboxReadiness(dossier.id);
    expect(readiness).toMatchObject({ readiness: "incomplete", documentedTestPlan: true, externalSubmission: false, admission: false, licence: false, providerActivation: false });
    expect(readiness.missingEvidenceCategories).toContain("reserve_attestation");
    const incident = await recordCbnSandboxIncident(actor, { dossierId: dossier.id, kind: "operational_resilience", severity: "medium", occurredAt: new Date("2026-09-02T10:00:00.000Z"), detectedAt: new Date("2026-09-02T10:01:00.000Z"), evidenceUri: "https://evidence.example.test/incident", summary: "Controlled test resilience interruption recorded for human review; no payment execution occurred." });
    expect(incident.notificationStatus).toBe("not_submitted");
    const pack = await createCbnSandboxReportingPack(actor, { dossierId: dossier.id, periodStart: new Date("2026-09-01T00:00:00.000Z"), periodEnd: new Date("2026-10-01T00:00:00.000Z"), artifactUri: "https://evidence.example.test/report-pack" });
    expect(pack).toMatchObject({ submissionStatus: "not_submitted", artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
});

afterAll(async () => {
  if (dossierId || entityId) {
    const dossier = dossierId ? `'${dossierId}'::uuid` : "NULL::uuid";
    const entity = entityId ? `'${entityId}'::uuid` : "NULL::uuid";
    const sql = `DELETE FROM cbn_sandbox_reporting_packs WHERE dossier_id=${dossier}; DELETE FROM cbn_sandbox_incidents WHERE dossier_id=${dossier}; DELETE FROM cbn_sandbox_consumer_records WHERE dossier_id=${dossier}; DELETE FROM cbn_sandbox_test_plans WHERE dossier_id=${dossier}; DELETE FROM cbn_sandbox_evidence_items WHERE dossier_id=${dossier}; DELETE FROM cbn_sandbox_dossiers WHERE id=${dossier}; DELETE FROM activity_events WHERE actor_subject='${actor.openId}'; DELETE FROM legal_entities WHERE id=${entity};`;
    execFileSync("sudo", ["-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-q", "-d", "umojaflowos_dev", "-c", sql], { stdio: "pipe" });
  }
  await closePostgresPool();
});
