import { createHash, randomUUID } from "node:crypto";
import { notifyOwner } from "./_core/notification";
import { appendSegregationOfDutiesAuditLog } from "./segregationOfDutiesAuditLog";
import { getPool } from "./postgres";

const ADVISORY_LOCK_KEY = 8_702_041_914;
const QUERY_VERSION = "sod-readiness-v1";
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 3_600;

type EvaluationState = "clean" | "exceptions_detected" | "indeterminate";
type Violation = {
  dossierId: string;
  itemId: string;
  area: string;
  code: "self_verification" | "invalid_state" | "invalid_dossier_total";
  evidenceRecordedBy?: string | null;
  verifiedBy?: string | null;
};

type MonitorActor = { subject: string; role: "system_monitor" };

export type SoDMonitorResult = {
  status: "clean" | "exceptions_detected" | "leader_unavailable" | "indeterminate";
  exceptionCount: number;
  correlationId?: string;
  reason?: string;
};

function strictEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error("UMOJA_SOD_MONITOR_ENABLED must be true or false");
}

function configuredInterval(value: string | undefined): number {
  if (value === undefined || value === "") return 300;
  if (!/^[0-9]+$/.test(value)) throw new Error("UMOJA_SOD_MONITOR_INTERVAL_SECONDS must be an integer");
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
    throw new Error(`UMOJA_SOD_MONITOR_INTERVAL_SECONDS must be between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}`);
  }
  return seconds;
}

function configuredSubject(value: string | undefined): string {
  const subject = value?.trim();
  if (!subject || subject.length < 3 || subject.length > 255) {
    throw new Error("UMOJA_SOD_MONITOR_SUBJECT must be a non-empty internal service subject");
  }
  return subject;
}

function canonicalDigest(violations: Violation[]): string {
  const canonical = violations
    .map(violation => ({
      area: violation.area,
      code: violation.code,
      dossierId: violation.dossierId,
      evidenceRecordedBy: violation.evidenceRecordedBy ?? null,
      itemId: violation.itemId,
      verifiedBy: violation.verifiedBy ?? null,
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

async function acquireLeader(): Promise<(() => Promise<void>) | null> {
  const client = await getPool().connect();
  try {
    const result = await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1) AS acquired", [ADVISORY_LOCK_KEY]);
    if (!result.rows[0]?.acquired) {
      client.release();
      return null;
    }
  } catch (error) {
    client.release();
    throw error;
  }
  return async () => {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    } finally {
      client.release();
    }
  };
}

async function queryViolations(): Promise<Violation[]> {
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{
      dossierId: string;
      itemId: string;
      area: string;
      code: Violation["code"];
      evidenceRecordedBy: string | null;
      verifiedBy: string | null;
    }>(`
      WITH self_verification AS (
        SELECT dossier_id AS "dossierId", id AS "itemId", area::text AS area,
               'self_verification'::text AS code,
               evidence_recorded_by AS "evidenceRecordedBy", verified_by AS "verifiedBy"
          FROM vasp_readiness_assurance_items
         WHERE status = 'externally_verified'
           AND verified_by = evidence_recorded_by
      ), invalid_state AS (
        SELECT dossier_id AS "dossierId", id AS "itemId", area::text AS area,
               'invalid_state'::text AS code,
               evidence_recorded_by AS "evidenceRecordedBy", verified_by AS "verifiedBy"
          FROM vasp_readiness_assurance_items
         WHERE (status = 'open' AND (
                  evidence_uri IS NOT NULL OR evidence_sha256 IS NOT NULL OR evidence_recorded_by IS NOT NULL OR
                  external_verifier IS NOT NULL OR verified_by IS NOT NULL OR rejection_rationale IS NOT NULL
                ))
            OR (status = 'evidence_recorded' AND (
                  evidence_uri IS NULL OR evidence_sha256 IS NULL OR evidence_recorded_by IS NULL OR
                  external_verifier IS NOT NULL OR verified_by IS NOT NULL OR rejection_rationale IS NOT NULL
                ))
            OR (status = 'externally_verified' AND (
                  evidence_uri IS NULL OR evidence_sha256 IS NULL OR evidence_recorded_by IS NULL OR
                  external_verifier IS NULL OR external_attestation_uri IS NULL OR external_attestation_sha256 IS NULL OR
                  verified_by IS NULL OR verification_rationale IS NULL OR rejection_rationale IS NOT NULL OR
                  verified_by = evidence_recorded_by
                ))
            OR (status = 'rejected' AND (
                  evidence_uri IS NULL OR evidence_sha256 IS NULL OR evidence_recorded_by IS NULL OR rejection_rationale IS NULL
                ))
      ), invalid_total AS (
        SELECT dossier_id AS "dossierId", min(id::text)::uuid AS "itemId", 'dossier_total'::text AS area,
               'invalid_dossier_total'::text AS code,
               NULL::text AS "evidenceRecordedBy", NULL::text AS "verifiedBy"
          FROM vasp_readiness_assurance_items
         GROUP BY dossier_id
        HAVING count(*) <> 6 OR count(DISTINCT area) <> 6 OR sum(max_points) <> 58
      )
      SELECT * FROM self_verification
      UNION ALL SELECT * FROM invalid_state
      UNION ALL SELECT * FROM invalid_total
    `);
    return rows;
  } finally {
    client.release();
  }
}

async function recordEvaluation(actor: MonitorActor, state: EvaluationState, violations: Violation[], errorSummary?: string): Promise<{ correlationId: string; digest?: string }> {
  const correlationId = randomUUID();
  const digest = violations.length ? canonicalDigest(violations) : state === "clean" ? canonicalDigest([]) : undefined;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO segregation_of_duties_evaluation_runs (
         correlation_id, evaluator_subject, evaluator_role, query_version,
         evaluation_state, exception_count, exception_digest, error_summary
       ) VALUES ($1, $2, $3::operating_role, $4, $5::segregation_of_duties_evaluation_state, $6, $7, $8)`,
      [correlationId, actor.subject, actor.role, QUERY_VERSION, state, violations.length, digest ?? null, errorSummary ?? null],
    );
    await client.query(
      `INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, correlation_id, metadata)
       VALUES ($1, $2::operating_role, $3, 'segregation_of_duties_evaluation', NULL, $4, $5::jsonb)`,
      [
        actor.subject,
        actor.role,
        `segregation_of_duties.${state}`,
        correlationId,
        JSON.stringify({ queryVersion: QUERY_VERSION, exceptionCount: violations.length, exceptionDigest: digest ?? null, errorSummary: errorSummary ?? null }),
      ],
    );
    await client.query("COMMIT");
    return { correlationId, digest };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function raiseAndDeliverExceptionAlert(actor: MonitorActor, correlationId: string, digest: string, violations: Violation[], environment: NodeJS.ProcessEnv): Promise<void> {
  const client = await getPool().connect();
  let created = false;
  let policyId: string | null = null;
  try {
    await client.query("BEGIN");
    const policy = await client.query<{ id: string }>(
      `SELECT id FROM alert_policies
        WHERE alert_type = 'segregation_of_duties' AND enabled = true
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    );
    if (!policy.rows[0]) {
      await client.query("COMMIT");
      return;
    }
    policyId = policy.rows[0].id;
    const sourceReference = `sod:${digest}`;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO compliance_alerts (
         alert_policy_id, alert_type, corridor, severity, source_reference, evidence, detected_at
       ) VALUES ($1, 'segregation_of_duties', NULL, 'critical', $2, $3::jsonb, now())
       ON CONFLICT (alert_policy_id, source_reference) DO NOTHING
       RETURNING id`,
      [policyId, sourceReference, JSON.stringify({ correlationId, exceptionDigest: digest, exceptionCount: violations.length, violations })],
    );
    created = Boolean(inserted.rows[0]);
    if (created) {
      await client.query(
        `INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, correlation_id, metadata)
         VALUES ($1, $2::operating_role, 'compliance_alert.raised', 'compliance_alert', $3, $4, $5::jsonb)`,
        [actor.subject, actor.role, inserted.rows[0].id, correlationId, JSON.stringify({ alertType: "segregation_of_duties", exceptionDigest: digest, exceptionCount: violations.length })],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  if (!created || !policyId) return;
  const title = "UmojaFlowOS segregation-of-duties exception";
  const content = `Detected ${violations.length} readiness-assurance segregation/state exception(s). Correlation: ${correlationId}. Evidence digest: ${digest}. Review the protected alert ledger; no readiness state, provider, or payment action was taken.`;
  const delivered = await notifyOwner({ title, content });
  const evidenceHash = createHash("sha256").update(`${title}\n${content}`).digest("hex");
  const deliveryClient = await getPool().connect();
  try {
    await deliveryClient.query("BEGIN");
    await deliveryClient.query(
      `INSERT INTO notification_deliveries (alert_policy_id, alert_type, delivery_state, destination, correlation_id, payload_hash)
       VALUES ($1, 'segregation_of_duties', $2, 'project_owner', $3, $4)`,
      [policyId, delivered ? "accepted" : "unavailable", correlationId, evidenceHash],
    );
    await deliveryClient.query(
      `INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, correlation_id, metadata)
       VALUES ($1, $2::operating_role, 'segregation_of_duties.notification_attempted', 'alert_delivery', NULL, $3, $4::jsonb)`,
      [actor.subject, actor.role, correlationId, JSON.stringify({ delivered, payloadHash: evidenceHash, exceptionDigest: digest })],
    );
    await deliveryClient.query("COMMIT");
    appendSegregationOfDutiesAuditLog({
      event: "sod_alert_delivery",
      occurredAt: new Date().toISOString(),
      correlationId,
      exceptionDigest: digest,
      deliveryState: delivered ? "accepted" : "unavailable",
    }, environment);
  } catch (error) {
    await deliveryClient.query("ROLLBACK");
    throw error;
  } finally {
    deliveryClient.release();
  }
}

export async function runSegregationOfDutiesMonitorRound(environment: NodeJS.ProcessEnv = process.env): Promise<SoDMonitorResult> {
  const actor: MonitorActor = { subject: configuredSubject(environment.UMOJA_SOD_MONITOR_SUBJECT), role: "system_monitor" };
  let release: (() => Promise<void>) | null = null;
  try {
    release = await acquireLeader();
    if (!release) return { status: "leader_unavailable", exceptionCount: 0 };
    const violations = await queryViolations();
    const state: EvaluationState = violations.length ? "exceptions_detected" : "clean";
    const recorded = await recordEvaluation(actor, state, violations);
    if (violations.length && recorded.digest) await raiseAndDeliverExceptionAlert(actor, recorded.correlationId, recorded.digest, violations, environment);
    appendSegregationOfDutiesAuditLog({
      event: "sod_monitor_evaluation",
      occurredAt: new Date().toISOString(),
      correlationId: recorded.correlationId,
      evaluationState: state,
      exceptionCount: violations.length,
      exceptionDigest: recorded.digest ?? null,
    }, environment);
    return { status: state, exceptionCount: violations.length, correlationId: recorded.correlationId };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      const recorded = await recordEvaluation(actor, "indeterminate", [], reason.slice(0, 4_000));
      appendSegregationOfDutiesAuditLog({
        event: "sod_monitor_indeterminate",
        occurredAt: new Date().toISOString(),
        correlationId: recorded.correlationId,
        evaluationState: "indeterminate",
        exceptionCount: 0,
        reasonCode: "monitor_error",
      }, environment);
      return { status: "indeterminate", exceptionCount: 0, correlationId: recorded.correlationId, reason };
    } catch {
      return { status: "indeterminate", exceptionCount: 0, reason };
    }
  } finally {
    if (release) await release().catch(() => undefined);
  }
}

export type SegregationOfDutiesMonitor = { stop: () => void };

export function startSegregationOfDutiesMonitor(
  environment: NodeJS.ProcessEnv = process.env,
  log: Pick<Console, "info" | "error"> = console,
): SegregationOfDutiesMonitor | null {
  if (!strictEnabled(environment.UMOJA_SOD_MONITOR_ENABLED)) return null;
  const intervalMilliseconds = configuredInterval(environment.UMOJA_SOD_MONITOR_INTERVAL_SECONDS) * 1_000;
  // Validate required subject before the first asynchronous execution.
  configuredSubject(environment.UMOJA_SOD_MONITOR_SUBJECT);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const scheduleNext = () => { if (!stopped) timer = setTimeout(run, intervalMilliseconds); };
  const run = async () => {
    const result = await runSegregationOfDutiesMonitorRound(environment);
    if (result.status === "indeterminate") log.error(`segregation-of-duties monitor indeterminate: ${result.reason ?? "unknown"}`);
    else log.info(`segregation-of-duties monitor ${result.status}: ${result.exceptionCount} exception(s)`);
    scheduleNext();
  };
  void run();
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

export const segregationOfDutiesMonitorConfiguration = { strictEnabled, configuredInterval, configuredSubject };
