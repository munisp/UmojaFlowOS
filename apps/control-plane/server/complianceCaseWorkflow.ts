import { randomUUID } from "node:crypto";
import { Pool } from "pg";

let pool: Pool | undefined;
function getPool() {
  if (!pool) {
    pool = process.env.POSTGRES_DATABASE_URL
      ? new Pool({ connectionString: process.env.POSTGRES_DATABASE_URL })
      : new Pool({
          host: "/var/run/postgresql",
          database: "umojaflowos_dev",
          user: process.env.POSTGRES_LOCAL_USER ?? "ubuntu",
        });
  }
  return pool;
}

export type CaseActor = { openId: string; role: string };

export type CaseStatus = "open" | "under_review" | "cleared" | "escalated" | "reported" | "closed";

/**
 * Allowed compliance-case dispositions.
 *
 * A case is a record of a human judgement, so the lifecycle is deliberately
 * narrow: a case must be reviewed before it can be cleared, escalated, or
 * reported, and a cleared or reported case can only be closed. Nothing
 * re-opens a closed case, because re-opening would let a later decision
 * silently overwrite an earlier attestation; a new case must be opened instead.
 */
const ALLOWED_CASE_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  open: ["under_review", "closed"],
  under_review: ["cleared", "escalated", "reported", "closed"],
  escalated: ["reported", "cleared", "closed"],
  cleared: ["closed"],
  reported: ["closed"],
  closed: [],
};

/**
 * Records a manual disposition on a compliance case.
 *
 * Every disposition requires an attributable rationale, because a case outcome
 * with no stated basis cannot be defended to a regulator. The transition and
 * its audit event commit in one transaction, so a disposition can never exist
 * without its evidence.
 */
export async function disposeComplianceCase(
  actor: CaseActor,
  input: { complianceCaseId: string; status: CaseStatus; decisionReason: string },
) {
  const decisionReason = input.decisionReason.trim();
  if (decisionReason.length < 20) {
    throw new Error("a compliance-case disposition requires an attributable rationale of at least 20 characters");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ status: CaseStatus; caseType: string }>(
      'SELECT status, case_type AS "caseType" FROM compliance_cases WHERE id=$1 FOR UPDATE',
      [input.complianceCaseId],
    );
    const existing = current.rows[0];
    if (!existing) throw new Error("compliance case was not found");

    const allowed = ALLOWED_CASE_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(input.status)) {
      throw new Error(`a compliance case in ${existing.status} cannot transition to ${input.status}`);
    }

    // A terminal disposition stamps the closing time; an intermediate one does not.
    const closesCase = input.status === "closed";
    const { rows } = await client.query<{ id: string; status: CaseStatus }>(
      `UPDATE compliance_cases
          SET status = $1::case_status,
              decision_reason = $2,
              closed_at = CASE WHEN $3 THEN now() ELSE closed_at END
        WHERE id = $4
        RETURNING id, status`,
      [input.status, decisionReason, closesCase, input.complianceCaseId],
    );
    const updated = rows[0];
    if (!updated) throw new Error("compliance-case disposition did not return a record");

    await client.query(
      "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
      [
        actor.openId,
        actor.role,
        "compliance_case.disposed",
        "compliance_case",
        updated.id,
        JSON.stringify({
          fromStatus: existing.status,
          toStatus: input.status,
          caseType: existing.caseType,
          decisionReason,
          decidedAt: new Date().toISOString(),
          evidenceReference: randomUUID(),
        }),
      ],
    );
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function allowedComplianceCaseTransitions(status: CaseStatus): CaseStatus[] {
  return [...(ALLOWED_CASE_TRANSITIONS[status] ?? [])];
}
