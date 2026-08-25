import type { PoolClient } from "pg";
import { getPool, type Actor } from "./postgres";

export const readinessAssuranceAreas = [
  "controlled_live_test",
  "governance_legal_ownership",
  "aml_cft_cpf_operations",
  "customer_asset_safeguarding",
  "cybersecurity_resilience",
  "consumer_incident_reporting",
] as const;

type AssuranceArea = (typeof readinessAssuranceAreas)[number];
type AssuranceStatus = "open" | "evidence_recorded" | "externally_verified" | "rejected";

type Blueprint = { maxPoints: number; requiredEvidence: string; accountableOwnerRole: string };

const blueprints: Record<AssuranceArea, Blueprint> = {
  controlled_live_test: { maxPoints: 7, accountableOwnerRole: "product_and_risk_owner", requiredEvidence: "Approved controlled-test plan, deployed test environment evidence, bounded transaction/exposure limits, independent reconciliation and wind-down exercise evidence." },
  governance_legal_ownership: { maxPoints: 8, accountableOwnerRole: "board_legal_company_secretary", requiredEvidence: "Applying legal-entity, beneficial-ownership, responsible-officer, policy approval, access review and governance-attestation evidence." },
  aml_cft_cpf_operations: { maxPoints: 14, accountableOwnerRole: "mlro_compliance_owner", requiredEvidence: "Approved AML/CFT/CPF programme, risk assessment, screening/monitoring evidence, reviewer training, escalation and record-retention evidence." },
  customer_asset_safeguarding: { maxPoints: 13, accountableOwnerRole: "custody_treasury_owner", requiredEvidence: "Custody or wallet architecture, asset segregation, key-management, reconciliation, reserve/redemption and wind-down evidence appropriate to the approved product scope." },
  cybersecurity_resilience: { maxPoints: 10, accountableOwnerRole: "ciso_platform_sre_owner", requiredEvidence: "MFA enrolment, secrets and certificate management, vulnerability remediation, penetration test, monitoring, backup/restore and disaster-recovery evidence." },
  consumer_incident_reporting: { maxPoints: 6, accountableOwnerRole: "consumer_protection_cbn_liaison", requiredEvidence: "Consumer disclosure/complaint evidence, exercised incident workflow, authorised reporting channel receipt, notification and retention evidence." },
};

async function activity(client: PoolClient, actor: Actor, action: string, objectId: string, metadata: Record<string, unknown>) {
  await client.query(
    "INSERT INTO activity_events (actor_subject,actor_role,action,object_type,object_id,metadata) VALUES ($1,$2,$3,'vasp_readiness_assurance_item',$4,$5::jsonb)",
    [actor.openId, actor.role, action, objectId, JSON.stringify({ ...metadata, source: "vasp-readiness-assurance", externalApproval: false, licence: false })],
  );
}

function blueprint(area: AssuranceArea): Blueprint {
  const selected = blueprints[area];
  if (!selected) throw new Error("unsupported readiness assurance area");
  return selected;
}

async function requireVaspDossier(client: PoolClient, dossierId: string) {
  const { rows } = await client.query<{ id: string; track: string }>("SELECT id,track FROM cbn_sandbox_dossiers WHERE id=$1 FOR KEY SHARE", [dossierId]);
  if (!rows[0]) throw new Error("CBN sandbox dossier does not exist");
  if (rows[0].track !== "vasp") throw new Error("readiness assurance items are available only for VASP dossiers");
}

export async function initialiseReadinessAssurance(actor: Actor, dossierId: string) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await requireVaspDossier(client, dossierId);
    for (const area of readinessAssuranceAreas) {
      const item = blueprint(area);
      await client.query(
        "INSERT INTO vasp_readiness_assurance_items (dossier_id,area,max_points,required_evidence,accountable_owner_role) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (dossier_id,area) DO NOTHING",
        [dossierId, area, item.maxPoints, item.requiredEvidence, item.accountableOwnerRole],
      );
    }
    await activity(client, actor, "vasp_readiness_assurance.initialised", dossierId, { areas: readinessAssuranceAreas, totalExternalPoints: 58 });
    await client.query("COMMIT");
    return listReadinessAssurance(dossierId);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function listReadinessAssurance(dossierId: string) {
  const { rows } = await getPool().query(
    `SELECT id,dossier_id AS "dossierId",area,max_points AS "maxPoints",required_evidence AS "requiredEvidence",accountable_owner_role AS "accountableOwnerRole",status,evidence_uri AS "evidenceUri",evidence_sha256 AS "evidenceSha256",evidence_recorded_by AS "evidenceRecordedBy",evidence_recorded_at AS "evidenceRecordedAt",external_verifier AS "externalVerifier",external_attestation_uri AS "externalAttestationUri",external_attestation_sha256 AS "externalAttestationSha256",verified_by AS "verifiedBy",verified_at AS "verifiedAt",verification_rationale AS "verificationRationale",rejection_rationale AS "rejectionRationale",created_at AS "createdAt",updated_at AS "updatedAt" FROM vasp_readiness_assurance_items WHERE dossier_id=$1 ORDER BY area`,
    [dossierId],
  );
  return rows;
}

export async function recordReadinessAssuranceEvidence(actor: Actor, input: { dossierId: string; area: AssuranceArea; evidenceUri: string; evidenceSha256: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await requireVaspDossier(client, input.dossierId);
    const result = await client.query<{ id: string; status: AssuranceStatus }>(
      `UPDATE vasp_readiness_assurance_items SET status='evidence_recorded',evidence_uri=$1,evidence_sha256=$2,evidence_recorded_by=$3,evidence_recorded_at=now(),external_verifier=NULL,external_attestation_uri=NULL,external_attestation_sha256=NULL,verified_by=NULL,verified_at=NULL,verification_rationale=NULL,rejection_rationale=NULL,updated_at=now() WHERE dossier_id=$4 AND area=$5 AND status IN ('open','rejected') RETURNING id,status`,
      [input.evidenceUri, input.evidenceSha256, actor.openId, input.dossierId, input.area],
    );
    const item = result.rows[0];
    if (!item) throw new Error("initialise the readiness assurance register first, or replace only an open/rejected item");
    await activity(client, actor, "vasp_readiness_assurance.evidence_recorded", item.id, { dossierId: input.dossierId, area: input.area, evidenceSha256: input.evidenceSha256, externallyVerified: false });
    await client.query("COMMIT");
    return item;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function verifyReadinessAssuranceEvidence(actor: Actor, input: { dossierId: string; area: AssuranceArea; externalVerifier: string; externalAttestationUri: string; externalAttestationSha256: string; rationale: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const selected = await client.query<{ id: string; evidenceRecordedBy: string | null }>("SELECT id,evidence_recorded_by AS \"evidenceRecordedBy\" FROM vasp_readiness_assurance_items WHERE dossier_id=$1 AND area=$2 AND status='evidence_recorded' FOR UPDATE", [input.dossierId, input.area]);
    const item = selected.rows[0];
    if (!item || !item.evidenceRecordedBy) throw new Error("record evidence before independent verification");
    if (item.evidenceRecordedBy === actor.openId) throw new Error("the evidence submitter cannot independently verify the same readiness item");
    await client.query(
      `UPDATE vasp_readiness_assurance_items SET status='externally_verified',external_verifier=$1,external_attestation_uri=$2,external_attestation_sha256=$3,verified_by=$4,verified_at=now(),verification_rationale=$5,rejection_rationale=NULL,updated_at=now() WHERE id=$6`,
      [input.externalVerifier, input.externalAttestationUri, input.externalAttestationSha256, actor.openId, input.rationale, item.id],
    );
    await activity(client, actor, "vasp_readiness_assurance.externally_verified", item.id, { dossierId: input.dossierId, area: input.area, externalVerifier: input.externalVerifier, attestationSha256: input.externalAttestationSha256, regulatorApproval: false, licence: false });
    await client.query("COMMIT");
    return { id: item.id, status: "externally_verified" as const };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function rejectReadinessAssuranceEvidence(actor: Actor, input: { dossierId: string; area: AssuranceArea; rationale: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ id: string }>("UPDATE vasp_readiness_assurance_items SET status='rejected',rejection_rationale=$1,updated_at=now() WHERE dossier_id=$2 AND area=$3 AND status='evidence_recorded' RETURNING id", [input.rationale, input.dossierId, input.area]);
    const item = result.rows[0]; if (!item) throw new Error("only recorded evidence can be rejected");
    await activity(client, actor, "vasp_readiness_assurance.rejected", item.id, { dossierId: input.dossierId, area: input.area, externalApproval: false });
    await client.query("COMMIT");
    return { id: item.id, status: "rejected" as const };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}

export async function assessReadinessAssurance(dossierId: string) {
  const items = await listReadinessAssurance(dossierId) as Array<{ maxPoints: number; status: AssuranceStatus }>;
  const verifiedPoints = items.filter(item => item.status === "externally_verified").reduce((sum, item) => sum + Number(item.maxPoints), 0);
  const totalPoints = items.reduce((sum, item) => sum + Number(item.maxPoints), 0);
  return { dossierId, items, verifiedPoints, remainingPoints: totalPoints - verifiedPoints, totalPoints, externalApproval: false, licence: false, admission: false };
}
