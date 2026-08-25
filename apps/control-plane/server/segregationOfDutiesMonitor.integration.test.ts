import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPool } from "./postgres";
import { runSegregationOfDutiesMonitorRound } from "./segregationOfDutiesMonitor";

describe("segregation-of-duties monitor", () => {
  it("records a clean evaluation without enabling an alert policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "umoja-sod-audit-"));
    const auditPath = join(directory, "sod-audit.jsonl");
    const result = await runSegregationOfDutiesMonitorRound({
      UMOJA_SOD_MONITOR_SUBJECT: "system:test-sod-monitor",
      UMOJA_SOD_AUDIT_LOG_PATH: auditPath,
    } as NodeJS.ProcessEnv);

    expect(result.status).toBe("clean");
    expect(result.exceptionCount).toBe(0);
    expect(result.correlationId).toBeTruthy();

    const pool = getPool();
    const evaluation = await pool.query<{ evaluationState: string; exceptionCount: number }>(
      `SELECT evaluation_state::text AS "evaluationState", exception_count AS "exceptionCount"
         FROM segregation_of_duties_evaluation_runs
        WHERE correlation_id = $1`,
      [result.correlationId],
    );
    expect(evaluation.rows).toHaveLength(1);
    expect(evaluation.rows[0]).toMatchObject({ evaluationState: "clean", exceptionCount: 0 });

    const alerts = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM compliance_alerts
        WHERE alert_type = 'segregation_of_duties'`,
    );
    expect(Number(alerts.rows[0].count)).toBe(0);

    const auditEvents = (await readFile(auditPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(auditEvents).toContainEqual(expect.objectContaining({
      event: "sod_monitor_evaluation",
      evaluationState: "clean",
      exceptionCount: 0,
      correlationId: result.correlationId,
    }));
    await rm(directory, { recursive: true, force: true });
  });
});
