import type { PoolClient } from "pg";
import { getPool, type Actor } from "./postgres";

export const supervisoryEvidenceCategories = [
  "incorporation_and_governing_documents",
  "resident_leadership_and_principal_officers",
  "legal_adviser_or_solicitor",
  "nfiu_registration",
  "financial_capacity_and_fidelity_bond",
  "aml_cft_cpf_and_travel_rule_programme",
  "technology_and_cybersecurity_controls",
  "consumer_protection_and_complaint_handling",
  "operational_reporting_and_incident_plan",
  "transition_or_orderly_exit_plan",
] as const;

export const travelRuleEvidenceCategories = [
  "originator_information_schema",
  "beneficiary_information_schema",
  "secure_counterparty_exchange_design",
  "counterparty_identity_and_authorisation",
  "exception_and_rejection_handling",
] as const;

export type SupervisoryEvidenceCategory = (typeof supervisoryEvidenceCategories)[number];
export type TravelRuleEvidenceCategory = (typeof travelRuleEvidenceCategories)[number];
export type SupervisoryPath = "sec_arip" | "sec_full_registration" | "other_supervisory_path";
export const offshoreExposureEvidenceCategories = ["jurisdictional_authorisation_scope", "ownership_and_control", "sanctions_and_adverse_media_process", "travel_rule_interoperability", "data_protection_and_retention", "incident_and_exit_contact"] as const;
export type OffshoreExposureCategory = (typeof offshoreExposureEvidenceCategories)[number];

async function activity(client: PoolClient, actor: Actor, action: string, objectType: string, objectId: string, metadata: Record<string, unknown>) {
  await client.query(
    "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [actor.openId, actor.role, action, objectType, objectId, JSON.stringify({ ...metadata, source: "vasp-regulatory-readiness", authoritative: false, externalTransmission: false, providerActivation: false, licenceClaimed: false })],
  );
}

async function requireVaspDossier(client: PoolClient, dossierId: string) {
  const { rows } = await client.query<{ id: string }>("SELECT id FROM cbn_sandbox_dossiers WHERE id=$1 AND track='vasp' FOR KEY SHARE", [dossierId]);
  if (!rows[0]) throw new Error("A canonical VASP dossier is required");
}

export async function listVaspRegulatoryProfiles() {
  const { rows } = await getPool().query(`
    SELECT p.id, p.dossier_id AS "dossierId", p.supervisory_path AS "supervisoryPath",
           p.operational_model_summary AS "operationalModelSummary", p.recorded_by AS "recordedBy", p.recorded_at AS "recordedAt",
           d.legal_entity_id AS "legalEntityId", e.legal_name AS "legalEntityName", d.product_name AS "productName"
    FROM vasp_regulatory_profiles p
    JOIN cbn_sandbox_dossiers d ON d.id=p.dossier_id
    JOIN legal_entities e ON e.id=d.legal_entity_id
    ORDER BY p.recorded_at DESC`);
  return rows;
}

export async function createVaspRegulatoryProfile(actor: Actor, input: { dossierId: string; supervisoryPath: SupervisoryPath; operationalModelSummary: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await requireVaspDossier(client, input.dossierId);
    const { rows } = await client.query<{ id: string }>(`
      INSERT INTO vasp_regulatory_profiles (dossier_id, supervisory_path, operational_model_summary, recorded_by)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (dossier_id) DO UPDATE SET supervisory_path=EXCLUDED.supervisory_path, operational_model_summary=EXCLUDED.operational_model_summary, recorded_by=EXCLUDED.recorded_by, recorded_at=now()
      RETURNING id`, [input.dossierId, input.supervisoryPath, input.operationalModelSummary, actor.openId]);
    const profile = rows[0]; if (!profile) throw new Error("VASP supervisory profile insert did not return a record");
    await activity(client, actor, "vasp_supervisory_profile.recorded", "vasp_regulatory_profile", profile.id, { dossierId: input.dossierId, supervisoryPath: input.supervisoryPath, externalSubmission: false, approvalInPrinciple: false });
    await client.query("COMMIT");
    return profile;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function recordVaspSupervisoryEvidence(actor: Actor, input: { profileId: string; category: SupervisoryEvidenceCategory; evidenceUri: string; evidenceSha256: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const profile = await client.query("SELECT id FROM vasp_regulatory_profiles WHERE id=$1 FOR KEY SHARE", [input.profileId]);
    if (!profile.rows[0]) throw new Error("VASP supervisory profile does not exist");
    const { rows } = await client.query<{ id: string }>(`
      INSERT INTO vasp_regulatory_evidence_items (profile_id, category, evidence_uri, evidence_sha256, recorded_by)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (profile_id, category, evidence_sha256) DO NOTHING RETURNING id`, [input.profileId, input.category, input.evidenceUri, input.evidenceSha256, actor.openId]);
    const id = rows[0]?.id;
    if (id) await activity(client, actor, "vasp_supervisory_evidence.recorded", "vasp_regulatory_evidence_item", id, { profileId: input.profileId, category: input.category, verified: false });
    await client.query("COMMIT");
    return { id: id ?? null, duplicate: !id };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function recordVaspTravelRuleEvidence(actor: Actor, input: { dossierId: string; counterpartyId: string; category: TravelRuleEvidenceCategory; evidenceUri: string; evidenceSha256: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await requireVaspDossier(client, input.dossierId);
    const counterparty = await client.query("SELECT id FROM counterparties WHERE id=$1 FOR KEY SHARE", [input.counterpartyId]);
    if (!counterparty.rows[0]) throw new Error("Counterparty does not exist");
    const { rows } = await client.query<{ id: string }>(`
      INSERT INTO vasp_travel_rule_evidence_items (dossier_id, counterparty_id, category, evidence_uri, evidence_sha256, recorded_by)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (dossier_id, counterparty_id, category, evidence_sha256) DO NOTHING RETURNING id`, [input.dossierId, input.counterpartyId, input.category, input.evidenceUri, input.evidenceSha256, actor.openId]);
    const id = rows[0]?.id;
    if (id) await activity(client, actor, "vasp_travel_rule_evidence.recorded", "vasp_travel_rule_evidence_item", id, { dossierId: input.dossierId, counterpartyId: input.counterpartyId, category: input.category, transmissionAttempted: false });
    await client.query("COMMIT");
    return { id: id ?? null, duplicate: !id };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

async function supervisoryCompleteness(client: PoolClient, profileId: string) {
  const { rows } = await client.query<{ category: SupervisoryEvidenceCategory }>("SELECT DISTINCT category FROM vasp_regulatory_evidence_items WHERE profile_id=$1", [profileId]);
  const recordedCategories = rows.map(row => row.category);
  const missingCategories = supervisoryEvidenceCategories.filter(category => !recordedCategories.includes(category));
  return { requiredCategories: [...supervisoryEvidenceCategories], recordedCategories, missingCategories, outcome: missingCategories.length === 0 ? "internal_record_complete_pending_external_review" as const : "internal_record_incomplete" as const, externalSubmission: false, approvalInPrinciple: false, fullRegistration: false };
}

export async function getVaspSupervisoryReadiness(profileId: string) {
  const client = await getPool().connect();
  try {
    const profile = await client.query("SELECT id FROM vasp_regulatory_profiles WHERE id=$1", [profileId]);
    if (!profile.rows[0]) throw new Error("VASP supervisory profile does not exist");
    return await supervisoryCompleteness(client, profileId);
  } finally { client.release(); }
}

export async function assessVaspTravelRuleRoute(actor: Actor, input: { dossierId: string; counterpartyId: string; reviewerRationale: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await requireVaspDossier(client, input.dossierId);
    const { rows: evidence } = await client.query<{ category: TravelRuleEvidenceCategory }>("SELECT DISTINCT category FROM vasp_travel_rule_evidence_items WHERE dossier_id=$1 AND counterparty_id=$2", [input.dossierId, input.counterpartyId]);
    const recordedCategories = evidence.map(row => row.category);
    const missingCategories = travelRuleEvidenceCategories.filter(category => !recordedCategories.includes(category));
    const outcome = missingCategories.length === 0 ? "internal_record_complete_pending_external_review" : "internal_record_incomplete";
    const { rows } = await client.query<{ id: string }>(`
      INSERT INTO vasp_travel_rule_route_assessments (dossier_id,counterparty_id,required_categories,recorded_categories,missing_categories,outcome,reviewer_rationale,assessed_by)
      VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8) RETURNING id`, [input.dossierId, input.counterpartyId, JSON.stringify(travelRuleEvidenceCategories), JSON.stringify(recordedCategories), JSON.stringify(missingCategories), outcome, input.reviewerRationale, actor.openId]);
    const assessment = rows[0]; if (!assessment) throw new Error("VASP Travel Rule assessment insert did not return a record");
    await activity(client, actor, "vasp_travel_rule_route.assessed", "vasp_travel_rule_route_assessment", assessment.id, { dossierId: input.dossierId, counterpartyId: input.counterpartyId, outcome, missingCategories, counterpartyVerified: false, travelRuleTransmission: false });
    await client.query("COMMIT");
    return { id: assessment.id, requiredCategories: [...travelRuleEvidenceCategories], recordedCategories, missingCategories, outcome, counterpartyVerified: false, travelRuleTransmission: false };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function listVaspTravelRuleAssessments(dossierId?: string) {
  const { rows } = await getPool().query(`
    SELECT id,dossier_id AS "dossierId",counterparty_id AS "counterpartyId",required_categories AS "requiredCategories",recorded_categories AS "recordedCategories",missing_categories AS "missingCategories",outcome,reviewer_rationale AS "reviewerRationale",assessed_by AS "assessedBy",assessed_at AS "assessedAt",external_counterparty_verification AS "externalCounterpartyVerification",external_transmission AS "externalTransmission"
    FROM vasp_travel_rule_route_assessments
    WHERE ($1::uuid IS NULL OR dossier_id=$1)
    ORDER BY assessed_at DESC`, [dossierId ?? null]);
  return rows;
}

export async function createVaspOffshoreCounterpartyProfile(actor: Actor, input: { dossierId: string; counterpartyId: string; homeJurisdiction: string; exposureTier: "standard" | "heightened" | "prohibited_review"; operatingSummary: string }) { const client = await getPool().connect(); try { await client.query("BEGIN"); await requireVaspDossier(client, input.dossierId); const counterparty = await client.query("SELECT id FROM counterparties WHERE id=$1 FOR KEY SHARE", [input.counterpartyId]); if (!counterparty.rows[0]) throw new Error("Counterparty does not exist"); const { rows } = await client.query<{ id: string }>("INSERT INTO vasp_offshore_counterparty_profiles (dossier_id,counterparty_id,home_jurisdiction,exposure_tier,operating_summary,recorded_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dossier_id,counterparty_id) DO UPDATE SET home_jurisdiction=EXCLUDED.home_jurisdiction,exposure_tier=EXCLUDED.exposure_tier,operating_summary=EXCLUDED.operating_summary,recorded_by=EXCLUDED.recorded_by,recorded_at=now() RETURNING id", [input.dossierId,input.counterpartyId,input.homeJurisdiction,input.exposureTier,input.operatingSummary,actor.openId]); const profile=rows[0]; if (!profile) throw new Error("Offshore counterparty profile was not recorded"); await activity(client,actor,"vasp_offshore_counterparty_profile.recorded","vasp_offshore_counterparty_profile",profile.id,{dossierId:input.dossierId,counterpartyId:input.counterpartyId,externalVerification:false,providerActivation:false}); await client.query("COMMIT"); return profile; } catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;} finally{client.release();} }
export async function recordVaspOffshoreCounterpartyEvidence(actor: Actor, input: { profileId: string; category: OffshoreExposureCategory; evidenceUri: string; evidenceSha256: string }) { const client=await getPool().connect(); try { await client.query("BEGIN"); const {rows}=await client.query<{id:string}>("INSERT INTO vasp_offshore_counterparty_evidence_items (profile_id,category,evidence_uri,evidence_sha256,recorded_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (profile_id,category,evidence_sha256) DO NOTHING RETURNING id",[input.profileId,input.category,input.evidenceUri,input.evidenceSha256,actor.openId]); const id=rows[0]?.id; if(id) await activity(client,actor,"vasp_offshore_counterparty_evidence.recorded","vasp_offshore_counterparty_evidence_item",id,{profileId:input.profileId,category:input.category,externalVerification:false}); await client.query("COMMIT"); return {id:id??null,duplicate:!id}; } catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;} finally{client.release();} }
export async function assessVaspOffshoreCounterpartyProfile(actor: Actor, input: { profileId: string; reviewerRationale: string }) { const client=await getPool().connect(); try { await client.query("BEGIN"); const evidence=await client.query<{category:OffshoreExposureCategory}>("SELECT DISTINCT category FROM vasp_offshore_counterparty_evidence_items WHERE profile_id=$1",[input.profileId]); const recordedCategories=evidence.rows.map(row=>row.category); const missingCategories=offshoreExposureEvidenceCategories.filter(category=>!recordedCategories.includes(category)); const outcome=missingCategories.length?"internal_record_incomplete":"internal_record_complete_pending_external_review"; const {rows}=await client.query<{id:string}>("INSERT INTO vasp_offshore_counterparty_assessments (profile_id,required_categories,recorded_categories,missing_categories,outcome,reviewer_rationale,assessed_by) VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$7) RETURNING id",[input.profileId,JSON.stringify(offshoreExposureEvidenceCategories),JSON.stringify(recordedCategories),JSON.stringify(missingCategories),outcome,input.reviewerRationale,actor.openId]); const assessment=rows[0]; if(!assessment) throw new Error("Offshore counterparty assessment was not recorded"); await activity(client,actor,"vasp_offshore_counterparty.assessed","vasp_offshore_counterparty_assessment",assessment.id,{profileId:input.profileId,outcome,missingCategories,externalVerification:false,providerActivation:false,custodyAuthority:false,valueMovement:false}); await client.query("COMMIT"); return {id:assessment.id,requiredCategories:[...offshoreExposureEvidenceCategories],recordedCategories,missingCategories,outcome,externalCounterpartyVerification:false,providerActivation:false,custodyAuthority:false,valueMovement:false}; } catch(error){await client.query("ROLLBACK").catch(()=>undefined);throw error;} finally{client.release();} }
