/**
 * Canonical compliance alert records.
 *
 * An alert states that a configured policy detected a condition. It is not a
 * decision and cannot become one: acknowledging an alert records that an
 * operator saw it, escalating it opens a compliance case where a binding
 * outcome can be reached, and dismissing it records an explicit, attributed
 * non-action. No path through this module clears a customer, approves a
 * payment, or closes a case.
 */

import { Pool } from "pg";

type AlertActor = { subject: string; role: string };

export type ComplianceAlertType =
  | "liquidity_threshold"
  | "payment_failure"
  | "compliance_flag"
  | "regulatory_deadline"
  | "segregation_of_duties";

export type ComplianceAlertSeverity = "low" | "medium" | "high" | "critical";

export type ComplianceAlertState =
  | "open"
  | "acknowledged"
  | "escalated"
  | "dismissed";

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: "/var/run/postgresql",
      database: "umojaflowos_dev",
      user: "ubuntu",
      max: 4,
    });
  }
  return pool;
}

/**
 * The alert lifecycle. An alert leaves `open` exactly once; terminal states are
 * final so an escalation cannot be quietly downgraded to a dismissal.
 */
const ALLOWED_TRANSITIONS: Record<ComplianceAlertState, ComplianceAlertState[]> = {
  open: ["acknowledged", "escalated", "dismissed"],
  // An acknowledged alert can still be escalated or dismissed: acknowledgement
  // is explicitly not a resolution.
  acknowledged: ["escalated", "dismissed"],
  escalated: [],
  dismissed: [],
};

export type ComplianceAlertRecord = {
  id: string;
  alertPolicyId: string;
  alertType: ComplianceAlertType;
  corridor: string | null;
  severity: ComplianceAlertSeverity;
  state: ComplianceAlertState;
  sourceReference: string;
  evidence: unknown;
  detectedAt: Date;
  paymentOrderId: string | null;
  customerId: string | null;
  counterpartyId: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  acknowledgementNote: string | null;
  escalatedCaseId: string | null;
  escalatedBy: string | null;
  escalatedAt: Date | null;
  dismissedBy: string | null;
  dismissedAt: Date | null;
  dismissalReason: string | null;
  createdAt: Date;
};

const ALERT_SELECT = `
  SELECT id,
         alert_policy_id      AS "alertPolicyId",
         alert_type           AS "alertType",
         corridor::text       AS corridor,
         severity,
         state::text          AS state,
         source_reference     AS "sourceReference",
         evidence,
         detected_at          AS "detectedAt",
         payment_order_id     AS "paymentOrderId",
         customer_id          AS "customerId",
         counterparty_id      AS "counterpartyId",
         acknowledged_by      AS "acknowledgedBy",
         acknowledged_at      AS "acknowledgedAt",
         acknowledgement_note AS "acknowledgementNote",
         escalated_case_id    AS "escalatedCaseId",
         escalated_by         AS "escalatedBy",
         escalated_at         AS "escalatedAt",
         dismissed_by         AS "dismissedBy",
         dismissed_at         AS "dismissedAt",
         dismissal_reason     AS "dismissalReason",
         created_at           AS "createdAt"
    FROM compliance_alerts
`;

/**
 * Raise an alert from a configured, enabled policy.
 *
 * Raising is idempotent per policy and source reference: re-evaluating the same
 * condition returns the existing alert rather than creating a duplicate, so an
 * operator queue reflects distinct conditions rather than evaluation frequency.
 */
export async function raisePostgresComplianceAlert(
  actor: AlertActor,
  input: {
    alertPolicyId: string;
    severity: ComplianceAlertSeverity;
    sourceReference: string;
    evidence: unknown;
    detectedAt: Date;
    paymentOrderId?: string | null;
    customerId?: string | null;
    counterpartyId?: string | null;
  },
): Promise<{ alert: ComplianceAlertRecord; created: boolean }> {
  if (input.sourceReference.trim().length < 8) {
    throw new Error(
      "compliance alert requires a verifiable source reference of at least 8 characters",
    );
  }
  if (input.evidence === null || input.evidence === undefined) {
    throw new Error("compliance alert requires detection evidence");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows: policies } = await client.query<{
      id: string;
      alertType: ComplianceAlertType;
      corridor: string | null;
      enabled: boolean;
    }>(
      `SELECT id, alert_type AS "alertType", corridor::text AS corridor, enabled
         FROM alert_policies
        WHERE id = $1
        FOR UPDATE`,
      [input.alertPolicyId],
    );
    const policy = policies[0];
    if (!policy) {
      throw new Error("alert policy not found; an alert cannot exist without its policy");
    }
    if (!policy.enabled) {
      throw new Error("alert policy is disabled; no alert was raised");
    }

    // Deduplicate against the same condition from the same policy.
    const { rows: existing } = await client.query<ComplianceAlertRecord>(
      `${ALERT_SELECT} WHERE alert_policy_id = $1 AND source_reference = $2`,
      [input.alertPolicyId, input.sourceReference],
    );
    if (existing[0]) {
      await client.query("COMMIT");
      return { alert: existing[0], created: false };
    }

    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO compliance_alerts (
         alert_policy_id, alert_type, corridor, severity, source_reference,
         evidence, detected_at, payment_order_id, customer_id, counterparty_id
       ) VALUES ($1, $2, $3::corridor_code, $4, $5, $6::jsonb, $7, $8, $9, $10)
       RETURNING id`,
      [
        input.alertPolicyId,
        policy.alertType,
        policy.corridor,
        input.severity,
        input.sourceReference,
        JSON.stringify(input.evidence),
        input.detectedAt,
        input.paymentOrderId ?? null,
        input.customerId ?? null,
        input.counterpartyId ?? null,
      ],
    );
    const alertId = inserted[0].id;

    await client.query(
      `INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata)
       VALUES ($1, $2::operating_role, 'compliance_alert.raised', 'compliance_alert', $3, $4::jsonb)`,
      [
        actor.subject,
        actor.role,
        alertId,
        JSON.stringify({
          alertType: policy.alertType,
          severity: input.severity,
          sourceReference: input.sourceReference,
          detectedAt: input.detectedAt.toISOString(),
        }),
      ],
    );

    const { rows: created } = await client.query<ComplianceAlertRecord>(
      `${ALERT_SELECT} WHERE id = $1`,
      [alertId],
    );
    await client.query("COMMIT");
    return { alert: created[0], created: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Acknowledge an alert. This records that a named operator reviewed it and what
 * they observed. It resolves nothing, which is why the alert remains actionable
 * for escalation or dismissal afterwards.
 */
export async function acknowledgePostgresComplianceAlert(
  actor: AlertActor,
  input: { alertId: string; note: string },
): Promise<ComplianceAlertRecord> {
  if (input.note.trim().length < 8) {
    throw new Error("acknowledgement requires a substantive note");
  }
  return transitionAlert(actor, input.alertId, "acknowledged", async (client, alertId) => {
    await client.query(
      `UPDATE compliance_alerts
          SET state = 'acknowledged',
              acknowledged_by = $2,
              acknowledged_by_role = $3::operating_role,
              acknowledged_at = now(),
              acknowledgement_note = $4
        WHERE id = $1`,
      [alertId, actor.subject, actor.role, input.note],
    );
    return { note: input.note };
  });
}

/**
 * Escalate an alert into a compliance case.
 *
 * The case must already exist and must reference the same subject as the alert
 * where the alert names one, so escalation produces a genuine investigative
 * link rather than an unrelated case number.
 */
export async function escalatePostgresComplianceAlert(
  actor: AlertActor,
  input: { alertId: string; caseId: string },
): Promise<ComplianceAlertRecord> {
  return transitionAlert(actor, input.alertId, "escalated", async (client, alertId, current) => {
    const { rows: cases } = await client.query<{
      id: string;
      status: string;
      customerId: string | null;
      paymentOrderId: string | null;
    }>(
      `SELECT id, status::text AS status,
              customer_id AS "customerId",
              payment_order_id AS "paymentOrderId"
         FROM compliance_cases
        WHERE id = $1
        FOR UPDATE`,
      [input.caseId],
    );
    const complianceCase = cases[0];
    if (!complianceCase) {
      throw new Error("escalation requires an existing compliance case");
    }
    if (complianceCase.status === "closed") {
      throw new Error("cannot escalate an alert into a closed compliance case");
    }
    if (
      current.customerId &&
      complianceCase.customerId &&
      current.customerId !== complianceCase.customerId
    ) {
      throw new Error("escalation case subject does not match the alert subject");
    }
    if (
      current.paymentOrderId &&
      complianceCase.paymentOrderId &&
      current.paymentOrderId !== complianceCase.paymentOrderId
    ) {
      throw new Error("escalation case payment order does not match the alert");
    }

    await client.query(
      `UPDATE compliance_alerts
          SET state = 'escalated',
              escalated_case_id = $2,
              escalated_by = $3,
              escalated_by_role = $4::operating_role,
              escalated_at = now()
        WHERE id = $1`,
      [alertId, input.caseId, actor.subject, actor.role],
    );
    return { caseId: input.caseId };
  });
}

/**
 * Dismiss an alert with a stated reason. Recorded as an attributed non-action so
 * a dismissal is reviewable rather than invisible.
 */
export async function dismissPostgresComplianceAlert(
  actor: AlertActor,
  input: { alertId: string; reason: string },
): Promise<ComplianceAlertRecord> {
  if (input.reason.trim().length < 8) {
    throw new Error("dismissal requires a substantive reason");
  }
  return transitionAlert(actor, input.alertId, "dismissed", async (client, alertId) => {
    await client.query(
      `UPDATE compliance_alerts
          SET state = 'dismissed',
              dismissed_by = $2,
              dismissed_by_role = $3::operating_role,
              dismissed_at = now(),
              dismissal_reason = $4
        WHERE id = $1`,
      [alertId, actor.subject, actor.role, input.reason],
    );
    return { reason: input.reason };
  });
}

async function transitionAlert(
  actor: AlertActor,
  alertId: string,
  target: ComplianceAlertState,
  apply: (
    client: import("pg").PoolClient,
    alertId: string,
    current: ComplianceAlertRecord,
  ) => Promise<Record<string, unknown>>,
): Promise<ComplianceAlertRecord> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<ComplianceAlertRecord>(
      `${ALERT_SELECT} WHERE id = $1 FOR UPDATE`,
      [alertId],
    );
    const current = rows[0];
    if (!current) {
      throw new Error("compliance alert not found");
    }

    const allowed = ALLOWED_TRANSITIONS[current.state];
    if (!allowed.includes(target)) {
      throw new Error(
        `compliance alert cannot move from ${current.state} to ${target}`,
      );
    }

    const metadata = await apply(client, alertId, current);

    await client.query(
      `INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata)
       VALUES ($1, $2::operating_role, $3, 'compliance_alert', $4, $5::jsonb)`,
      [
        actor.subject,
        actor.role,
        `compliance_alert.${target}`,
        alertId,
        JSON.stringify({ from: current.state, to: target, ...metadata }),
      ],
    );

    const { rows: updated } = await client.query<ComplianceAlertRecord>(
      `${ALERT_SELECT} WHERE id = $1`,
      [alertId],
    );
    await client.query("COMMIT");
    return updated[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Auditor-readable alert ledger. */
export async function listPostgresComplianceAlerts(options: {
  state?: ComplianceAlertState;
  limit?: number;
} = {}): Promise<ComplianceAlertRecord[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const client = await getPool().connect();
  try {
    if (options.state) {
      const { rows } = await client.query<ComplianceAlertRecord>(
        `${ALERT_SELECT} WHERE state = $1::compliance_alert_state
          ORDER BY detected_at DESC LIMIT $2`,
        [options.state, limit],
      );
      return rows;
    }
    const { rows } = await client.query<ComplianceAlertRecord>(
      `${ALERT_SELECT} ORDER BY detected_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  } finally {
    client.release();
  }
}
