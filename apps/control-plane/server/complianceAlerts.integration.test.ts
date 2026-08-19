/**
 * Local PostgreSQL regressions for the compliance alert lifecycle.
 *
 * These prove an alert is an attention record rather than a decision: it always
 * carries its originating evidence, escalation must produce a real case link,
 * and no terminal state can be silently rewritten.
 *
 * Opt in with POSTGRES_INTEGRATION_TEST=1.
 */

import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  raisePostgresComplianceAlert,
  acknowledgePostgresComplianceAlert,
  escalatePostgresComplianceAlert,
  dismissPostgresComplianceAlert,
  listPostgresComplianceAlerts,
} from "./complianceAlerts";

const RUN = process.env.POSTGRES_INTEGRATION_TEST === "1";
const suite = RUN ? describe : describe.skip;

const pool = new Pool({
  host: "/var/run/postgresql",
  database: "umojaflowos_dev",
  user: "ubuntu",
  max: 3,
});

const officer = { subject: "regression-alert-officer", role: "compliance_officer" };
const admin = { subject: "regression-alert-admin", role: "admin" };

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function createEnabledPolicy(alertType: string, corridor: string | null) {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO alert_policies (alert_type, corridor, threshold, enabled, created_by)
     VALUES ($1, $2::corridor_code, $3::jsonb, true, $4)
     RETURNING id`,
    [alertType, corridor, JSON.stringify({ regressionFixture: true }), "regression-alert-admin"],
  );
  return rows[0].id;
}

async function createOpenCase() {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO compliance_cases (case_type, severity, source_reference)
     VALUES ('transaction_monitoring', 'high', $1)
     RETURNING id`,
    [unique("regression-alert-case")],
  );
  return rows[0].id;
}

suite("compliance alert lifecycle", () => {
  it("raises an alert carrying its originating evidence and deduplicates re-evaluation", async () => {
    const policyId = await createEnabledPolicy("compliance_flag", "NIGERIA_NGN");
    const sourceReference = unique("regression-alert-source");
    const detectedAt = new Date();
    const evidence = {
      rule: "counterparty_licence_unverified",
      observedValue: "pending_review",
      thresholdReference: "CBN licence register",
    };

    const first = await raisePostgresComplianceAlert(officer, {
      alertPolicyId: policyId,
      severity: "high",
      sourceReference,
      evidence,
      detectedAt,
    });

    expect(first.created).toBe(true);
    expect(first.alert.state).toBe("open");
    expect(first.alert.sourceReference).toBe(sourceReference);
    // The detection evidence is persisted verbatim, so a reviewer can see what
    // was true at detection time rather than re-deriving it later.
    expect(first.alert.evidence).toMatchObject(evidence);

    // Re-evaluating the same condition must not create a second queue entry.
    const second = await raisePostgresComplianceAlert(officer, {
      alertPolicyId: policyId,
      severity: "high",
      sourceReference,
      evidence,
      detectedAt: new Date(),
    });
    expect(second.created).toBe(false);
    expect(second.alert.id).toBe(first.alert.id);
  });

  it("refuses to raise an alert without a policy, without evidence, or from a disabled policy", async () => {
    const disabledPolicyId = await createEnabledPolicy("payment_failure", null);
    await pool.query(`UPDATE alert_policies SET enabled = false WHERE id = $1`, [
      disabledPolicyId,
    ]);

    await expect(
      raisePostgresComplianceAlert(officer, {
        alertPolicyId: disabledPolicyId,
        severity: "medium",
        sourceReference: unique("regression-alert-disabled"),
        evidence: { rule: "disabled" },
        detectedAt: new Date(),
      }),
    ).rejects.toThrow(/disabled/i);

    const enabledPolicyId = await createEnabledPolicy("payment_failure", null);
    await expect(
      raisePostgresComplianceAlert(officer, {
        alertPolicyId: enabledPolicyId,
        severity: "medium",
        // Too short to identify anything verifiable.
        sourceReference: "short",
        evidence: { rule: "x" },
        detectedAt: new Date(),
      }),
    ).rejects.toThrow(/source reference/i);
  });

  it("acknowledges without resolving, then still permits escalation", async () => {
    const policyId = await createEnabledPolicy("compliance_flag", "KENYA_KES");
    const { alert } = await raisePostgresComplianceAlert(officer, {
      alertPolicyId: policyId,
      severity: "critical",
      sourceReference: unique("regression-alert-ack"),
      evidence: { rule: "structuring_band" },
      detectedAt: new Date(),
    });

    const acknowledged = await acknowledgePostgresComplianceAlert(officer, {
      alertId: alert.id,
      note: "Reviewed the underlying transactions; pattern warrants investigation.",
    });
    expect(acknowledged.state).toBe("acknowledged");
    expect(acknowledged.acknowledgedBy).toBe(officer.subject);
    // Acknowledgement is explicitly not a resolution: no case, no dismissal.
    expect(acknowledged.escalatedCaseId).toBeNull();
    expect(acknowledged.dismissedAt).toBeNull();

    const caseId = await createOpenCase();
    const escalated = await escalatePostgresComplianceAlert(officer, {
      alertId: alert.id,
      caseId,
    });
    expect(escalated.state).toBe("escalated");
    expect(escalated.escalatedCaseId).toBe(caseId);
  });

  it("requires a real, open case for escalation and never leaves a dangling escalation", async () => {
    const policyId = await createEnabledPolicy("compliance_flag", "SOUTH_AFRICA_ZAR");
    const { alert } = await raisePostgresComplianceAlert(officer, {
      alertPolicyId: policyId,
      severity: "high",
      sourceReference: unique("regression-alert-nocase"),
      evidence: { rule: "sanctions_screening_unavailable" },
      detectedAt: new Date(),
    });

    await expect(
      escalatePostgresComplianceAlert(officer, {
        alertId: alert.id,
        caseId: "00000000-0000-0000-0000-000000000000",
      }),
    ).rejects.toThrow(/existing compliance case/i);

    const closedCaseId = await createOpenCase();
    await pool.query(
      `UPDATE compliance_cases SET status = 'closed', closed_at = now() WHERE id = $1`,
      [closedCaseId],
    );
    await expect(
      escalatePostgresComplianceAlert(officer, { alertId: alert.id, caseId: closedCaseId }),
    ).rejects.toThrow(/closed compliance case/i);

    // The alert is untouched by the refused escalations.
    const [current] = (await listPostgresComplianceAlerts({ limit: 500 })).filter(
      (row) => row.id === alert.id,
    );
    expect(current.state).toBe("open");
    expect(current.escalatedCaseId).toBeNull();
  });

  it("treats escalation and dismissal as terminal", async () => {
    const policyId = await createEnabledPolicy("compliance_flag", null);
    const { alert } = await raisePostgresComplianceAlert(officer, {
      alertPolicyId: policyId,
      severity: "low",
      sourceReference: unique("regression-alert-terminal"),
      evidence: { rule: "velocity_count" },
      detectedAt: new Date(),
    });

    const dismissed = await dismissPostgresComplianceAlert(admin, {
      alertId: alert.id,
      reason: "Duplicate of an existing investigation already under review.",
    });
    expect(dismissed.state).toBe("dismissed");
    expect(dismissed.dismissalReason).toMatch(/duplicate/i);

    const caseId = await createOpenCase();
    await expect(
      escalatePostgresComplianceAlert(officer, { alertId: alert.id, caseId }),
    ).rejects.toThrow(/cannot move from dismissed/i);
    await expect(
      acknowledgePostgresComplianceAlert(officer, {
        alertId: alert.id,
        reason: undefined as never,
        note: "Attempting to reopen after dismissal.",
      }),
    ).rejects.toThrow(/cannot move from dismissed/i);
  });

  it("writes an attributed audit event for every lifecycle step", async () => {
    const policyId = await createEnabledPolicy("compliance_flag", "NIGERIA_NGN");
    const { alert } = await raisePostgresComplianceAlert(officer, {
      alertPolicyId: policyId,
      severity: "medium",
      sourceReference: unique("regression-alert-audit"),
      evidence: { rule: "reporting_threshold" },
      detectedAt: new Date(),
    });
    await acknowledgePostgresComplianceAlert(officer, {
      alertId: alert.id,
      note: "Confirmed the threshold breach against the recorded observation.",
    });
    const caseId = await createOpenCase();
    await escalatePostgresComplianceAlert(officer, { alertId: alert.id, caseId });

    const { rows } = await pool.query<{ action: string; actorSubject: string }>(
      `SELECT action, actor_subject AS "actorSubject"
         FROM activity_events
        WHERE object_type = 'compliance_alert' AND object_id = $1
        ORDER BY occurred_at`,
      [alert.id],
    );
    const actions = rows.map((row) => row.action);
    expect(actions).toContain("compliance_alert.raised");
    expect(actions).toContain("compliance_alert.acknowledged");
    expect(actions).toContain("compliance_alert.escalated");
    for (const row of rows) {
      expect(row.actorSubject).toBeTruthy();
    }
  });
});
