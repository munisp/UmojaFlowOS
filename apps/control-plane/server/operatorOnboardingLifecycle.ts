import { getPool, type Actor } from "./postgres";

export type OperatorOnboardingPhase = "role_access_request" | "lms_enrolment" | "shadow_period" | "steady_state";

export type OperatorOnboardingRecord = {
  id: string;
  subject: string;
  phase: OperatorOnboardingPhase;
  sodMatrixReviewed: boolean;
  sodMatrixReviewedBy: string | null;
  sodMatrixReviewedAt: Date | null;
  sodMatrixNote: string | null;
  lmsCertReference: string | null;
  lmsCertAssignedAt: Date | null;
  shadowPeriodSupervisedBy: string | null;
  shadowPeriodStartedAt: Date | null;
  shadowPeriodEndedAt: Date | null;
  steadyStateActivatedAt: Date | null;
  nextRecertDueAt: Date | null;
  createdBy: string;
  createdAt: Date;
};

const columns = `id, subject, phase, sod_matrix_reviewed AS "sodMatrixReviewed", sod_matrix_reviewed_by AS "sodMatrixReviewedBy", sod_matrix_reviewed_at AS "sodMatrixReviewedAt", sod_matrix_note AS "sodMatrixNote",
  lms_cert_reference AS "lmsCertReference", lms_cert_assigned_at AS "lmsCertAssignedAt",
  shadow_period_supervised_by AS "shadowPeriodSupervisedBy", shadow_period_started_at AS "shadowPeriodStartedAt", shadow_period_ended_at AS "shadowPeriodEndedAt",
  steady_state_activated_at AS "steadyStateActivatedAt", next_recert_due_at AS "nextRecertDueAt", created_by AS "createdBy", created_at AS "createdAt"`;

async function recordActivity(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, actor: Actor, action: string, objectId: string, metadata: Record<string, unknown>) {
  await client.query(
    "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,'operator_onboarding_record',$4,$5::jsonb)",
    [actor.openId, actor.role, action, objectId, JSON.stringify(metadata)],
  );
}

export async function listOperatorOnboardingRecords(): Promise<OperatorOnboardingRecord[]> {
  const { rows } = await getPool().query<OperatorOnboardingRecord>(`SELECT ${columns} FROM operator_onboarding_records ORDER BY created_at DESC`);
  return rows;
}

/** Fig 3.1 phase 1: "Role + access request" -- opens the lifecycle record for a subject that already has a role grant. */
export async function startOperatorOnboarding(actor: Actor, input: { subject: string }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<OperatorOnboardingRecord>(
      `INSERT INTO operator_onboarding_records (subject, created_by) VALUES ($1,$2) RETURNING ${columns}`,
      [input.subject, actor.openId],
    );
    const record = rows[0];
    if (!record) throw new Error("operator onboarding record insert did not return a record");
    await recordActivity(client, actor, "operator_onboarding.started", record.id, { subject: input.subject });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Fig 3.1 phase 1 (cont.): the SoD matrix half of "Role + access request · SoD matrix" — advances to LMS enrolment. */
export async function recordSodMatrixReview(actor: Actor, input: { onboardingId: string; note: string }) {
  if (input.note.trim().length < 10) throw new Error("a SoD matrix review note of at least 10 characters is required");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ phase: OperatorOnboardingPhase }>("SELECT phase FROM operator_onboarding_records WHERE id=$1 FOR UPDATE", [input.onboardingId]);
    if (!current.rows[0]) throw new Error("operator onboarding record was not found");
    if (current.rows[0].phase !== "role_access_request") throw new Error("SoD matrix review only applies at the role-access-request phase");
    const { rows } = await client.query<OperatorOnboardingRecord>(
      `UPDATE operator_onboarding_records SET sod_matrix_reviewed=true, sod_matrix_reviewed_by=$2, sod_matrix_reviewed_at=now(), sod_matrix_note=$3, phase='lms_enrolment'
       WHERE id=$1 RETURNING ${columns}`,
      [input.onboardingId, actor.openId, input.note.trim()],
    );
    const record = rows[0];
    if (!record) throw new Error("operator onboarding record update did not return a record");
    await recordActivity(client, actor, "operator_onboarding.sod_matrix_reviewed", record.id, { note: input.note.trim() });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Fig 3.1 phase 2: "LMS enrolment · cert assignment" -- advances to shadow period. */
export async function recordLmsEnrolment(actor: Actor, input: { onboardingId: string; certReference: string }) {
  if (!input.certReference.trim()) throw new Error("a certification reference is required");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ phase: OperatorOnboardingPhase }>("SELECT phase FROM operator_onboarding_records WHERE id=$1 FOR UPDATE", [input.onboardingId]);
    if (!current.rows[0]) throw new Error("operator onboarding record was not found");
    if (current.rows[0].phase !== "lms_enrolment") throw new Error("LMS enrolment only applies at the lms-enrolment phase");
    const { rows } = await client.query<OperatorOnboardingRecord>(
      `UPDATE operator_onboarding_records SET lms_cert_reference=$2, lms_cert_assigned_at=now(), phase='shadow_period'
       WHERE id=$1 RETURNING ${columns}`,
      [input.onboardingId, input.certReference.trim()],
    );
    const record = rows[0];
    if (!record) throw new Error("operator onboarding record update did not return a record");
    await recordActivity(client, actor, "operator_onboarding.lms_enrolled", record.id, { certReference: input.certReference.trim() });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Fig 3.1 phase 3: "Shadow period · first ticket supervision" -- advances to steady-state. */
export async function recordShadowPeriodSupervision(actor: Actor, input: { onboardingId: string; supervisedBy: string }) {
  if (!input.supervisedBy.trim()) throw new Error("a supervising operator is required");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ phase: OperatorOnboardingPhase }>("SELECT phase FROM operator_onboarding_records WHERE id=$1 FOR UPDATE", [input.onboardingId]);
    if (!current.rows[0]) throw new Error("operator onboarding record was not found");
    if (current.rows[0].phase !== "shadow_period") throw new Error("shadow-period supervision only applies at the shadow-period phase");
    const { rows } = await client.query<OperatorOnboardingRecord>(
      `UPDATE operator_onboarding_records SET shadow_period_supervised_by=$2, shadow_period_started_at=COALESCE(shadow_period_started_at, now()), shadow_period_ended_at=now(), phase='steady_state'
       WHERE id=$1 RETURNING ${columns}`,
      [input.onboardingId, input.supervisedBy.trim()],
    );
    const record = rows[0];
    if (!record) throw new Error("operator onboarding record update did not return a record");
    await recordActivity(client, actor, "operator_onboarding.shadow_period_supervised", record.id, { supervisedBy: input.supervisedBy.trim() });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Fig 3.1 phase 4: "Annual recert · access review" -- sets/refreshes the next due date; re-triggerable every cycle. */
export async function recordOperatorRecertification(actor: Actor, input: { onboardingId: string; nextRecertDueAt: Date }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ phase: OperatorOnboardingPhase }>("SELECT phase FROM operator_onboarding_records WHERE id=$1 FOR UPDATE", [input.onboardingId]);
    if (!current.rows[0]) throw new Error("operator onboarding record was not found");
    if (current.rows[0].phase !== "steady_state") throw new Error("recertification only applies once steady-state has been reached");
    const { rows } = await client.query<OperatorOnboardingRecord>(
      `UPDATE operator_onboarding_records SET steady_state_activated_at=COALESCE(steady_state_activated_at, now()), next_recert_due_at=$2
       WHERE id=$1 RETURNING ${columns}`,
      [input.onboardingId, input.nextRecertDueAt],
    );
    const record = rows[0];
    if (!record) throw new Error("operator onboarding record update did not return a record");
    await recordActivity(client, actor, "operator_onboarding.recertified", record.id, { nextRecertDueAt: input.nextRecertDueAt.toISOString() });
    await client.query("COMMIT");
    return record;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
