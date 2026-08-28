import { getPool, type Actor } from "./postgres";

export type AuditorEngagementPhase = "engagement_letter" | "access_provisioning" | "audit_fieldwork" | "annual_review";

export type AuditorEngagementRecord = {
  id: string;
  auditorFirmName: string;
  engagementReference: string;
  phase: AuditorEngagementPhase;
  engagementLetterUri: string | null;
  engagementLetterSignedAt: Date | null;
  scopeNote: string | null;
  auditorSubject: string | null;
  accessProvisionedAt: Date | null;
  accessProvisionedBy: string | null;
  fieldworkNote: string | null;
  fieldworkStartedAt: Date | null;
  fieldworkCompletedAt: Date | null;
  lastAnnualReviewAt: Date | null;
  nextAnnualReviewDueAt: Date | null;
  createdBy: string;
  createdAt: Date;
};

const columns = `id, auditor_firm_name AS "auditorFirmName", engagement_reference AS "engagementReference", phase,
  engagement_letter_uri AS "engagementLetterUri", engagement_letter_signed_at AS "engagementLetterSignedAt", scope_note AS "scopeNote",
  auditor_subject AS "auditorSubject", access_provisioned_at AS "accessProvisionedAt", access_provisioned_by AS "accessProvisionedBy",
  fieldwork_note AS "fieldworkNote", fieldwork_started_at AS "fieldworkStartedAt", fieldwork_completed_at AS "fieldworkCompletedAt",
  last_annual_review_at AS "lastAnnualReviewAt", next_annual_review_due_at AS "nextAnnualReviewDueAt", created_by AS "createdBy", created_at AS "createdAt"`;

async function recordActivity(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, actor: Actor, action: string, objectId: string, metadata: Record<string, unknown>) {
  await client.query(
    "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,'auditor_engagement_record',$4,$5::jsonb)",
    [actor.openId, actor.role, action, objectId, JSON.stringify(metadata)],
  );
}

export async function listAuditorEngagements(): Promise<AuditorEngagementRecord[]> {
  const { rows } = await getPool().query<AuditorEngagementRecord>(`SELECT ${columns} FROM auditor_engagement_records ORDER BY created_at DESC`);
  return rows;
}

/** Fig 3.1 phase 1: "Engagement letter · scope signed" -- opens the engagement record. */
export async function startAuditorEngagement(actor: Actor, input: { auditorFirmName: string; engagementReference: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<AuditorEngagementRecord>(
      `INSERT INTO auditor_engagement_records (auditor_firm_name, engagement_reference, created_by) VALUES ($1,$2,$3) RETURNING ${columns}`,
      [input.auditorFirmName, input.engagementReference, actor.openId],
    );
    const record = rows[0];
    if (!record) throw new Error("auditor engagement record insert did not return a record");
    await recordActivity(client, actor, "auditor_engagement.started", record.id, { auditorFirmName: input.auditorFirmName, engagementReference: input.engagementReference });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Fig 3.1 phase 1 (cont.): records the signed engagement letter and scope -- advances to access provisioning. */
export async function recordEngagementLetter(actor: Actor, input: { engagementId: string; engagementLetterUri: string; scopeNote: string }) {
  if (input.scopeNote.trim().length < 10) throw new Error("a scope note of at least 10 characters is required");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ phase: AuditorEngagementPhase }>("SELECT phase FROM auditor_engagement_records WHERE id=$1 FOR UPDATE", [input.engagementId]);
    if (!current.rows[0]) throw new Error("auditor engagement record was not found");
    if (current.rows[0].phase !== "engagement_letter") throw new Error("the engagement letter step only applies at the engagement-letter phase");
    const { rows } = await client.query<AuditorEngagementRecord>(
      `UPDATE auditor_engagement_records SET engagement_letter_uri=$2, engagement_letter_signed_at=now(), scope_note=$3, phase='access_provisioning'
       WHERE id=$1 RETURNING ${columns}`,
      [input.engagementId, input.engagementLetterUri, input.scopeNote.trim()],
    );
    const record = rows[0];
    if (!record) throw new Error("auditor engagement record update did not return a record");
    await recordActivity(client, actor, "auditor_engagement.letter_signed", record.id, { engagementLetterUri: input.engagementLetterUri });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Fig 3.1 phase 2: "Read-only access provisioning" -- advances to fieldwork.
 * Records that the named subject was granted read-only (auditor-role)
 * platform access; the grant itself is made through the existing operator
 * directory (Ch.11 / Admins page), not duplicated here.
 */
export async function recordAccessProvisioning(actor: Actor, input: { engagementId: string; auditorSubject: string }) {
  if (!input.auditorSubject.trim()) throw new Error("the provisioned auditor's platform subject is required");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ phase: AuditorEngagementPhase }>("SELECT phase FROM auditor_engagement_records WHERE id=$1 FOR UPDATE", [input.engagementId]);
    if (!current.rows[0]) throw new Error("auditor engagement record was not found");
    if (current.rows[0].phase !== "access_provisioning") throw new Error("access provisioning only applies at the access-provisioning phase");
    const { rows } = await client.query<AuditorEngagementRecord>(
      `UPDATE auditor_engagement_records SET auditor_subject=$2, access_provisioned_at=now(), access_provisioned_by=$3, phase='audit_fieldwork'
       WHERE id=$1 RETURNING ${columns}`,
      [input.engagementId, input.auditorSubject.trim(), actor.openId],
    );
    const record = rows[0];
    if (!record) throw new Error("auditor engagement record update did not return a record");
    await recordActivity(client, actor, "auditor_engagement.access_provisioned", record.id, { auditorSubject: input.auditorSubject.trim() });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Fig 3.1 phase 3 (inferred -- the source cell is corrupted by a
 * PDF-extraction overlap artifact; legible fragments suggest a site
 * visit/inspection with Country Lead involvement). Records audit fieldwork
 * and advances to the annual-review phase.
 */
export async function recordAuditFieldwork(actor: Actor, input: { engagementId: string; fieldworkNote: string }) {
  if (input.fieldworkNote.trim().length < 10) throw new Error("a fieldwork note of at least 10 characters is required");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ phase: AuditorEngagementPhase }>("SELECT phase FROM auditor_engagement_records WHERE id=$1 FOR UPDATE", [input.engagementId]);
    if (!current.rows[0]) throw new Error("auditor engagement record was not found");
    if (current.rows[0].phase !== "audit_fieldwork") throw new Error("fieldwork recording only applies at the audit-fieldwork phase");
    const { rows } = await client.query<AuditorEngagementRecord>(
      `UPDATE auditor_engagement_records SET fieldwork_note=$2, fieldwork_started_at=COALESCE(fieldwork_started_at, now()), fieldwork_completed_at=now(), phase='annual_review'
       WHERE id=$1 RETURNING ${columns}`,
      [input.engagementId, input.fieldworkNote.trim()],
    );
    const record = rows[0];
    if (!record) throw new Error("auditor engagement record update did not return a record");
    await recordActivity(client, actor, "auditor_engagement.fieldwork_recorded", record.id, { fieldworkNote: input.fieldworkNote.trim() });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Fig 3.1 phase 4 (inferred -- same corrupted cell; legible fragments
 * suggest an annual supervisory review with Compliance preparation).
 * Re-triggerable every cycle once the annual-review phase is reached.
 */
export async function recordAnnualReview(actor: Actor, input: { engagementId: string; nextAnnualReviewDueAt: Date }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ phase: AuditorEngagementPhase }>("SELECT phase FROM auditor_engagement_records WHERE id=$1 FOR UPDATE", [input.engagementId]);
    if (!current.rows[0]) throw new Error("auditor engagement record was not found");
    if (current.rows[0].phase !== "annual_review") throw new Error("annual review only applies once the annual-review phase has been reached");
    const { rows } = await client.query<AuditorEngagementRecord>(
      `UPDATE auditor_engagement_records SET last_annual_review_at=now(), next_annual_review_due_at=$2
       WHERE id=$1 RETURNING ${columns}`,
      [input.engagementId, input.nextAnnualReviewDueAt],
    );
    const record = rows[0];
    if (!record) throw new Error("auditor engagement record update did not return a record");
    await recordActivity(client, actor, "auditor_engagement.annual_review_recorded", record.id, { nextAnnualReviewDueAt: input.nextAnnualReviewDueAt.toISOString() });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
