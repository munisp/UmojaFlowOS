import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { createCbnSandboxDossier } from "./cbnSandbox";
import { registerPostgresLegalEntity } from "./legalEntityRegistry";
import { closePostgresPool, createPostgresCounterparty } from "./postgres";
import { postgresTestSchemaOwnerPsqlArguments } from "./testPostgres";
import { assessVaspTravelRuleRoute, createVaspRegulatoryProfile, getVaspSupervisoryReadiness, recordVaspSupervisoryEvidence, recordVaspTravelRuleEvidence, supervisoryEvidenceCategories, travelRuleEvidenceCategories } from "./vaspReadiness";

const run = process.env.POSTGRES_INTEGRATION_TEST === "1" ? describe : describe.skip;
const admin = { openId: `vasp-readiness-admin-${crypto.randomUUID()}`, role: "admin" as const };
const compliance = { openId: `vasp-readiness-compliance-${crypto.randomUUID()}`, role: "compliance_officer" as const };
let entityId: string | undefined;
let dossierId: string | undefined;
let profileId: string | undefined;
let counterpartyId: string | undefined;

const sha = (index: number) => index.toString(16).padStart(64, "0");

run("VASP supervisory and Travel Rule readiness", () => {
  it("records coverage as internal readiness and refuses all external authority", async () => {
    const entity = await registerPostgresLegalEntity(admin, { legalName: `VASP Readiness ${crypto.randomUUID().slice(0, 8)}`, jurisdiction: "Nigeria", registrationIdentifier: `vasp-${crypto.randomUUID()}` });
    entityId = entity.id;
    const dossier = await createCbnSandboxDossier(admin, { legalEntityId: entity.id, track: "vasp", productName: "VASP supervisory evidence controls", productSummary: "Evidence-only VASP supervisory and Travel Rule readiness controls for Nigeria (NGN), with no regulatory submission, provider activation, custody, or payment execution." });
    dossierId = dossier.id;
    const counterparty = await createPostgresCounterparty(admin, { legalName: `VASP Counterparty ${crypto.randomUUID().slice(0, 8)}`, counterpartyType: "stablecoin_provider", jurisdiction: "Nigeria" });
    counterpartyId = counterparty.id;
    const profile = await createVaspRegulatoryProfile(admin, { dossierId: dossier.id, supervisoryPath: "sec_arip", operationalModelSummary: "The platform retains an internal evidence record for supervisory review and protects counterparties by blocking all external submissions, Travel Rule transmissions, provider activation, custody, and value movement until separately authorised." });
    profileId = profile.id;

    const initiallyIncomplete = await getVaspSupervisoryReadiness(profile.id);
    expect(initiallyIncomplete).toMatchObject({ outcome: "internal_record_incomplete", externalSubmission: false, approvalInPrinciple: false, fullRegistration: false });
    expect(initiallyIncomplete.missingCategories).toContain("nfiu_registration");

    for (const [index, category] of supervisoryEvidenceCategories.entries()) {
      await recordVaspSupervisoryEvidence(compliance, { profileId: profile.id, category, evidenceUri: `https://evidence.example.test/vasp/${category}`, evidenceSha256: sha(index + 1) });
    }
    const readiness = await getVaspSupervisoryReadiness(profile.id);
    expect(readiness).toMatchObject({ outcome: "internal_record_complete_pending_external_review", missingCategories: [], externalSubmission: false, approvalInPrinciple: false, fullRegistration: false });

    for (const [index, category] of travelRuleEvidenceCategories.entries()) {
      await recordVaspTravelRuleEvidence(compliance, { dossierId: dossier.id, counterpartyId: counterparty.id, category, evidenceUri: `https://evidence.example.test/travel-rule/${category}`, evidenceSha256: sha(index + 101) });
    }
    const assessment = await assessVaspTravelRuleRoute(compliance, { dossierId: dossier.id, counterpartyId: counterparty.id, reviewerRationale: "This review compares only retained internal evidence with required Travel Rule route categories; it does not verify a counterparty externally or transmit originator or beneficiary data." });
    expect(assessment).toMatchObject({ outcome: "internal_record_complete_pending_external_review", missingCategories: [], counterpartyVerified: false, travelRuleTransmission: false });
  });
});

afterAll(async () => {
  if (dossierId || profileId || counterpartyId || entityId) {
    const dossier = dossierId ? `'${dossierId}'::uuid` : "NULL::uuid";
    const profile = profileId ? `'${profileId}'::uuid` : "NULL::uuid";
    const counterparty = counterpartyId ? `'${counterpartyId}'::uuid` : "NULL::uuid";
    const entity = entityId ? `'${entityId}'::uuid` : "NULL::uuid";
    const sql = `DELETE FROM vasp_travel_rule_route_assessments WHERE dossier_id=${dossier}; DELETE FROM vasp_travel_rule_evidence_items WHERE dossier_id=${dossier}; DELETE FROM vasp_regulatory_evidence_items WHERE profile_id=${profile}; DELETE FROM vasp_regulatory_profiles WHERE id=${profile}; DELETE FROM cbn_sandbox_evidence_assessments WHERE dossier_id=${dossier}; DELETE FROM cbn_sandbox_reporting_packs WHERE dossier_id=${dossier}; DELETE FROM cbn_sandbox_incidents WHERE dossier_id=${dossier}; DELETE FROM cbn_sandbox_consumer_records WHERE dossier_id=${dossier}; DELETE FROM cbn_sandbox_test_plans WHERE dossier_id=${dossier}; DELETE FROM cbn_sandbox_evidence_items WHERE dossier_id=${dossier}; DELETE FROM cbn_sandbox_dossiers WHERE id=${dossier}; DELETE FROM counterparties WHERE id=${counterparty}; DELETE FROM activity_events WHERE actor_subject IN ('${admin.openId}','${compliance.openId}'); DELETE FROM legal_entities WHERE id=${entity};`;
    execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", ...postgresTestSchemaOwnerPsqlArguments(), "-c", sql], { stdio: "pipe" });
  }
  await closePostgresPool();
});
