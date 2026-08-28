import type { PoolClient } from "pg";
import { getPool, type Actor } from "./postgres";
import { resolveOperatorAccessRequest } from "./operatorAccessRequests";

export type ExternalStakeholderRole = "provider_contact" | "cbn_liaison";
type ProviderEvidenceCategory = "provider_licensing" | "product_entitlement" | "technical_endpoint" | "callback_configuration" | "operating_runbook";
type CbnEvidenceCategory = "application_correspondence" | "review_request" | "review_response";

const providerEvidenceCategories = new Set<ProviderEvidenceCategory>(["provider_licensing", "product_entitlement", "technical_endpoint", "callback_configuration", "operating_runbook"]);
const cbnEvidenceCategories = new Set<CbnEvidenceCategory>(["application_correspondence", "review_request", "review_response"]);

async function activity(client: PoolClient, actor: Actor, action: string, objectType: string, objectId: string, metadata: Record<string, unknown>) {
  await client.query(
    "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [actor.openId, actor.role, action, objectType, objectId, JSON.stringify({ ...metadata, authoritative: false, providerActivation: false, paymentExecution: false, settlement: false, externalSubmission: false, admission: false, licence: false })],
  );
}

export async function assignExternalStakeholder(actor: Actor, input: { role: ExternalStakeholderRole; stakeholderSubject: string; counterpartyId?: string; dossierId?: string }) {
  if ((input.role === "provider_contact") !== Boolean(input.counterpartyId) || (input.role === "cbn_liaison") !== Boolean(input.dossierId)) throw new Error("external stakeholder assignment must match its evidence-only subject");
  const client = await getPool().connect();
  let assignment: { id: string; status: string };
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO operator_role_assignments (subject,role,status,assigned_by)
       VALUES ($1,$2,'assigned',$3)
       ON CONFLICT (subject) DO UPDATE
       SET role=EXCLUDED.role,status='assigned',assigned_by=EXCLUDED.assigned_by,assigned_at=now(),suspended_at=NULL`,
      [input.stakeholderSubject, input.role, actor.openId],
    );
    if (input.counterpartyId) {
      const counterparty = await client.query("SELECT id FROM counterparties WHERE id=$1 FOR KEY SHARE", [input.counterpartyId]);
      if (!counterparty.rows[0]) throw new Error("counterparty does not exist");
    }
    if (input.dossierId) {
      const dossier = await client.query("SELECT id FROM cbn_sandbox_dossiers WHERE id=$1 FOR KEY SHARE", [input.dossierId]);
      if (!dossier.rows[0]) throw new Error("CBN sandbox dossier does not exist");
    }
    const { rows } = await client.query<{ id: string; status: string }>(
      `INSERT INTO external_stakeholder_assignments (stakeholder_role,stakeholder_subject,counterparty_id,dossier_id,assigned_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (stakeholder_role,stakeholder_subject,counterparty_id,dossier_id) DO UPDATE SET status='assigned',suspended_at=NULL,assigned_by=EXCLUDED.assigned_by,assigned_at=now()
       RETURNING id,status`,
      [input.role, input.stakeholderSubject, input.counterpartyId ?? null, input.dossierId ?? null, actor.openId],
    );
    const created = rows[0]; if (!created) throw new Error("external stakeholder assignment did not return a record");
    assignment = created;
    await activity(client, actor, "external_stakeholder.assigned", "external_stakeholder_assignment", assignment.id, { stakeholderRole: input.role, counterpartyAssigned: Boolean(input.counterpartyId), dossierAssigned: Boolean(input.dossierId) });
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }

  await resolveOperatorAccessRequest(actor, input.stakeholderSubject);
  return assignment;
}

export async function listProviderContactAssignments(subject: string) {
  const { rows } = await getPool().query(`SELECT a.id,a.status,a.assigned_at AS "assignedAt",c.id AS "counterpartyId",c.legal_name AS "counterpartyLegalName",o.stage AS "onboardingStage" FROM external_stakeholder_assignments a JOIN counterparties c ON c.id=a.counterparty_id LEFT JOIN counterparty_onboardings o ON o.counterparty_id=c.id WHERE a.stakeholder_role='provider_contact' AND a.stakeholder_subject=$1 ORDER BY a.assigned_at DESC`, [subject]);
  return rows;
}

export async function listCbnLiaisonAssignments(subject: string) {
  const { rows } = await getPool().query(`SELECT a.id,a.status,a.assigned_at AS "assignedAt",d.id AS "dossierId",e.legal_name AS "legalEntityName",d.track,d.product_name AS "productName",d.status AS "dossierStatus",false AS "externalSubmission",false AS admission,false AS licence FROM external_stakeholder_assignments a JOIN cbn_sandbox_dossiers d ON d.id=a.dossier_id JOIN legal_entities e ON e.id=d.legal_entity_id WHERE a.stakeholder_role='cbn_liaison' AND a.stakeholder_subject=$1 ORDER BY a.assigned_at DESC`, [subject]);
  return rows;
}

export async function recordExternalStakeholderEvidence(actor: Actor, input: { assignmentId: string; category: ProviderEvidenceCategory | CbnEvidenceCategory; evidenceUri: string; evidenceSha256: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const assignment = await client.query<{ role: ExternalStakeholderRole; subject: string; status: string }>("SELECT stakeholder_role AS role,stakeholder_subject AS subject,status FROM external_stakeholder_assignments WHERE id=$1 FOR KEY SHARE", [input.assignmentId]);
    const row = assignment.rows[0];
    if (!row || row.subject !== actor.openId || row.role !== actor.role || row.status !== "assigned") throw new Error("active external stakeholder assignment is required");
    if ((row.role === "provider_contact" && !providerEvidenceCategories.has(input.category as ProviderEvidenceCategory)) || (row.role === "cbn_liaison" && !cbnEvidenceCategories.has(input.category as CbnEvidenceCategory))) throw new Error("evidence category is not permitted for this external stakeholder role");
    const { rows } = await client.query<{ id: string }>("INSERT INTO external_stakeholder_evidence (assignment_id,category,evidence_uri,evidence_sha256,recorded_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (assignment_id,category,evidence_sha256) DO NOTHING RETURNING id", [input.assignmentId, input.category, input.evidenceUri, input.evidenceSha256, actor.openId]);
    const id = rows[0]?.id;
    if (id) await activity(client, actor, "external_stakeholder_evidence.recorded", "external_stakeholder_evidence", id, { assignmentId: input.assignmentId, stakeholderRole: row.role, category: input.category, evidenceSupplied: true, verified: false });
    await client.query("COMMIT"); return { id: id ?? null, duplicate: !id, externalSubmission: false, admission: false, licence: false, providerActivation: false, paymentExecution: false, settlement: false };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
}
