import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool, type Actor } from "./postgres";

const vaspCategories = ["corporate_governance", "ownership", "financial_capacity", "aml_cft_cpf", "consumer_protection", "cybersecurity", "data_protection", "operational_resilience", "business_continuity", "stablecoin_governance", "reserve_attestation", "redemption", "custody_key_management", "third_party_oversight", "testing_plan"] as const;
const dataEnabledCategories = ["corporate_governance", "ownership", "financial_capacity", "aml_cft_cpf", "consumer_protection", "cybersecurity", "data_protection", "operational_resilience", "business_continuity", "third_party_oversight", "testing_plan"] as const;

type Track = "vasp" | "data_enabled_non_vasp";
type EvidenceCategory = (typeof vaspCategories)[number];

async function activity(client: PoolClient, actor: Actor, action: string, objectType: string, objectId: string, metadata: Record<string, unknown>) {
  await client.query(
    "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [actor.openId, actor.role, action, objectType, objectId, JSON.stringify({ ...metadata, source: "cbn-sandbox-readiness", authoritative: false })],
  );
}

export async function listCbnSandboxDossiers() {
  const { rows } = await getPool().query(`SELECT d.id, d.legal_entity_id AS "legalEntityId", e.legal_name AS "legalEntityName", d.track, d.product_name AS "productName", d.product_summary AS "productSummary", d.status, d.external_submission_reference AS "externalSubmissionReference", d.created_at AS "createdAt", d.updated_at AS "updatedAt" FROM cbn_sandbox_dossiers d JOIN legal_entities e ON e.id=d.legal_entity_id ORDER BY d.updated_at DESC`);
  return rows;
}

export async function createCbnSandboxDossier(actor: Actor, input: { legalEntityId: string; track: Track; productName: string; productSummary: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const legalEntity = await client.query("SELECT id, jurisdiction FROM legal_entities WHERE id=$1 FOR KEY SHARE", [input.legalEntityId]);
    if (!legalEntity.rows[0] || legalEntity.rows[0].jurisdiction !== "Nigeria") throw new Error("A canonical Nigeria legal entity is required for a CBN sandbox dossier");
    const { rows } = await client.query<{ id: string; status: string }>(`INSERT INTO cbn_sandbox_dossiers (legal_entity_id,track,product_name,product_summary,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id,status`, [input.legalEntityId, input.track, input.productName, input.productSummary, actor.openId]);
    const dossier = rows[0]; if (!dossier) throw new Error("CBN sandbox dossier insert did not return a record");
    await activity(client, actor, "cbn_sandbox_dossier.created", "cbn_sandbox_dossier", dossier.id, { track: input.track, status: dossier.status, externalSubmission: false, admissionClaimed: false, providerActivation: false });
    await client.query("COMMIT"); return dossier;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function recordCbnSandboxEvidence(actor: Actor, input: { dossierId: string; category: EvidenceCategory; evidenceUri: string; evidenceSha256: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const dossier = await client.query("SELECT id FROM cbn_sandbox_dossiers WHERE id=$1 FOR KEY SHARE", [input.dossierId]);
    if (!dossier.rows[0]) throw new Error("CBN sandbox dossier does not exist");
    const { rows } = await client.query<{ id: string }>(`INSERT INTO cbn_sandbox_evidence_items (dossier_id,category,evidence_uri,evidence_sha256,recorded_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dossier_id,category,evidence_sha256) DO NOTHING RETURNING id`, [input.dossierId, input.category, input.evidenceUri, input.evidenceSha256, actor.openId]);
    const id = rows[0]?.id;
    if (id) await activity(client, actor, "cbn_sandbox_evidence.recorded", "cbn_sandbox_dossier", input.dossierId, { category: input.category, evidenceSha256: input.evidenceSha256, evidenceSupplied: true, verified: false });
    await client.query("COMMIT"); return { id: id ?? null, duplicate: !id };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function createCbnSandboxTestPlan(actor: Actor, input: { dossierId: string; permittedUse: string; userCategory: string; maxTransactions: number; maxAggregateExposure: string; startsAt: Date; endsAt: Date; successMetricsUri: string; windDownUri: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const dossier = await client.query("SELECT id FROM cbn_sandbox_dossiers WHERE id=$1 FOR KEY SHARE", [input.dossierId]);
    if (!dossier.rows[0]) throw new Error("CBN sandbox dossier does not exist");
    const { rows } = await client.query<{ id: string; status: string }>(`INSERT INTO cbn_sandbox_test_plans (dossier_id,status,permitted_use,user_category,max_transactions,max_aggregate_exposure,starts_at,ends_at,success_metrics_uri,wind_down_uri,documented_by) VALUES ($1,'documented',$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (dossier_id) DO UPDATE SET status='documented',permitted_use=EXCLUDED.permitted_use,user_category=EXCLUDED.user_category,max_transactions=EXCLUDED.max_transactions,max_aggregate_exposure=EXCLUDED.max_aggregate_exposure,starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,success_metrics_uri=EXCLUDED.success_metrics_uri,wind_down_uri=EXCLUDED.wind_down_uri,documented_by=EXCLUDED.documented_by,documented_at=now() RETURNING id,status`, [input.dossierId, input.permittedUse, input.userCategory, input.maxTransactions, input.maxAggregateExposure, input.startsAt, input.endsAt, input.successMetricsUri, input.windDownUri, actor.openId]);
    const plan = rows[0]; if (!plan) throw new Error("CBN sandbox test-plan insert did not return a record");
    await activity(client, actor, "cbn_sandbox_test_plan.documented", "cbn_sandbox_test_plan", plan.id, { dossierId: input.dossierId, maxTransactions: input.maxTransactions, maxAggregateExposure: input.maxAggregateExposure, executionPermitted: false, settlementPermitted: false, externalApprovalAsserted: false });
    await client.query("COMMIT"); return plan;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function getCbnSandboxReadiness(dossierId: string) {
  const client = await getPool().connect();
  try {
    const dossier = await client.query<{ id: string; track: Track; status: string }>("SELECT id,track,status FROM cbn_sandbox_dossiers WHERE id=$1", [dossierId]);
    const row = dossier.rows[0]; if (!row) throw new Error("CBN sandbox dossier does not exist");
    const evidence = await client.query<{ category: EvidenceCategory }>("SELECT category FROM cbn_sandbox_evidence_items WHERE dossier_id=$1", [dossierId]);
    const available = new Set(evidence.rows.map(item => item.category));
    const expected = row.track === "vasp" ? vaspCategories : dataEnabledCategories;
    const plan = await client.query("SELECT id FROM cbn_sandbox_test_plans WHERE dossier_id=$1", [dossierId]);
    const missing = expected.filter(category => !available.has(category));
    return { dossierId, track: row.track, dossierStatus: row.status, readiness: missing.length === 0 && Boolean(plan.rows[0]) ? "evidence_complete_pending_external_review" : "incomplete", missingEvidenceCategories: missing, documentedTestPlan: Boolean(plan.rows[0]), externalSubmission: false, admission: false, licence: false, providerActivation: false };
  } finally { client.release(); }
}

export async function recordCbnSandboxConsumerRecord(actor: Actor, input: { dossierId: string; customerId: string; recordKind: "disclosure_acceptance" | "complaint"; disclosureVersion?: string; evidenceUri: string; details: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; status: string }>(`INSERT INTO cbn_sandbox_consumer_records (dossier_id,customer_id,record_kind,disclosure_version,evidence_uri,details,status,recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,status`, [input.dossierId, input.customerId, input.recordKind, input.disclosureVersion ?? null, input.evidenceUri, input.details, input.recordKind === "complaint" ? "under_review" : "recorded", actor.openId]);
    const record = rows[0]; if (!record) throw new Error("CBN sandbox consumer record insert did not return a record");
    await activity(client, actor, `cbn_sandbox_consumer_${input.recordKind}.recorded`, "cbn_sandbox_consumer_record", record.id, { dossierId: input.dossierId, customerId: input.customerId, status: record.status, externalNotification: false });
    await client.query("COMMIT"); return record;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function recordCbnSandboxIncident(actor: Actor, input: { dossierId: string; kind: "cybersecurity" | "fraud" | "consumer_harm" | "operational_resilience"; severity: "low" | "medium" | "high" | "critical"; occurredAt: Date; detectedAt: Date; evidenceUri: string; summary: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; notificationStatus: string }>(`INSERT INTO cbn_sandbox_incidents (dossier_id,kind,severity,occurred_at,detected_at,evidence_uri,summary,recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,notification_status AS "notificationStatus"`, [input.dossierId, input.kind, input.severity, input.occurredAt, input.detectedAt, input.evidenceUri, input.summary, actor.openId]);
    const incident = rows[0]; if (!incident) throw new Error("CBN sandbox incident insert did not return a record");
    await activity(client, actor, "cbn_sandbox_incident.recorded", "cbn_sandbox_incident", incident.id, { dossierId: input.dossierId, kind: input.kind, severity: input.severity, notificationStatus: incident.notificationStatus, externalNotification: false });
    await client.query("COMMIT"); return incident;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function createCbnSandboxReportingPack(actor: Actor, input: { dossierId: string; periodStart: Date; periodEnd: Date; artifactUri: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const source = await client.query(`SELECT jsonb_build_object('evidence',(SELECT coalesce(jsonb_agg(jsonb_build_object('category',category,'sha256',evidence_sha256) ORDER BY category,evidence_sha256),'[]'::jsonb) FROM cbn_sandbox_evidence_items WHERE dossier_id=$1),'incidents',(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'severity',severity,'occurred_at',occurred_at) ORDER BY occurred_at),'[]'::jsonb) FROM cbn_sandbox_incidents WHERE dossier_id=$1 AND occurred_at >= $2 AND occurred_at < $3),'consumer_records',(SELECT coalesce(jsonb_agg(jsonb_build_object('kind',record_kind,'status',status,'recorded_at',recorded_at) ORDER BY recorded_at),'[]'::jsonb) FROM cbn_sandbox_consumer_records WHERE dossier_id=$1 AND recorded_at >= $2 AND recorded_at < $3)) AS manifest`, [input.dossierId, input.periodStart, input.periodEnd]);
    if (!source.rows[0]) throw new Error("CBN sandbox dossier does not exist");
    const manifest = source.rows[0].manifest; const digest = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    const { rows } = await client.query<{ id: string; submissionStatus: string }>(`INSERT INTO cbn_sandbox_reporting_packs (dossier_id,period_start,period_end,artifact_uri,artifact_sha256,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,submission_status AS "submissionStatus"`, [input.dossierId, input.periodStart, input.periodEnd, input.artifactUri, digest, actor.openId]);
    const pack = rows[0]; if (!pack) throw new Error("CBN sandbox reporting pack insert did not return a record");
    await activity(client, actor, "cbn_sandbox_reporting_pack.created", "cbn_sandbox_reporting_pack", pack.id, { dossierId: input.dossierId, artifactSha256: digest, submissionStatus: pack.submissionStatus, externalSubmission: false });
    await client.query("COMMIT"); return { ...pack, artifactSha256: digest, manifest };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}
