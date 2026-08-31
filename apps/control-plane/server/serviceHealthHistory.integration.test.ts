import { execFileSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { closePostgresPool, getPool } from "./postgres";
import { postgresTestSchemaOwnerPsqlArguments } from "./testPostgres";
import type { ServiceStatus } from "./serviceHealth";
import { listServiceHealthHistory, recordServiceHealthSamples, summariseServiceAvailability } from "./serviceHealthHistory";

/**
 * A trend chart is only as honest as its samples, so these regressions target
 * the two ways a health chart usually lies: recording an unreachable service as
 * a fast zero-latency response, and reporting perfect availability for a
 * service that was never actually observed.
 */
const run = process.env.POSTGRES_INTEGRATION_TEST === "1" ? describe : describe.skip;
const runApplicationRoleBoundary = process.env.UMOJA_POSTGRES_APPLICATION_ROLE_VALIDATION === "1";

const healthy = (service: ServiceStatus["service"], latency: number, counters: Record<string, number> = {}): ServiceStatus => ({
  service,
  language: service === "reporting-analytics" ? "python" : service === "payment-engine" ? "go" : "rust",
  status: "healthy",
  latencyMs: latency,
  uptimeSeconds: 120,
  observedAt: new Date().toISOString(),
  counters,
  posture: { provider_execution: "unavailable" },
});

/**
 * Samples are append-only to the application role, which is the point: a
 * recorded incident cannot be edited out of the trend it appears in. Test
 * cleanup therefore runs as the schema owner rather than weakening the grant,
 * and the fact that the application connection *cannot* do this is itself
 * asserted below.
 */
function purge() {
  execFileSync("psql", ["-q", ...postgresTestSchemaOwnerPsqlArguments(), "-c", "DELETE FROM service_health_samples"], { stdio: "ignore" });
}

run("service health history", () => {
  afterAll(async () => { purge(); await closePostgresPool(); });

  it("records an unreachable service with its reason and no fabricated latency", async () => {
    purge();
    await recordServiceHealthSamples([
      { service: "risk-compliance-core", language: "rust", status: "unreachable", reason: "connect ECONNREFUSED", latencyMs: null },
      { service: "reporting-analytics", language: "python", status: "not_configured", reason: "UMOJA_REPORTING_URL is not set" },
    ]);

    const history = await listServiceHealthHistory({ sinceMinutes: 10 });
    const risk = history.find(sample => sample.service === "risk-compliance-core");
    const reporting = history.find(sample => sample.service === "reporting-analytics");

    expect(risk?.status).toBe("unreachable");
    // The distinction that matters: no latency at all, rather than zero.
    expect(risk?.latencyMs).toBeNull();
    expect(risk?.reason).toContain("ECONNREFUSED");
    expect(reporting?.status).toBe("not_configured");
    expect(reporting?.reason).toContain("UMOJA_REPORTING_URL");
  });

  it("stores every reported counter verbatim and invents none", async () => {
    purge();
    await recordServiceHealthSamples([healthy("payment-engine", 12, { orders_validated: 7, orders_refused: 2 })]);

    const [sample] = await listServiceHealthHistory({ sinceMinutes: 10 });
    expect(sample.counters).toEqual({ orders_validated: 7, orders_refused: 2 });
    expect(sample.posture).toEqual({ provider_execution: "unavailable" });
    expect(sample.latencyMs).toBe(12);
  });

  it("gives every sample in one round the same collection time so series align", async () => {
    purge();
    const at = new Date();
    await recordServiceHealthSamples([healthy("payment-engine", 10), healthy("risk-compliance-core", 20), healthy("ledger-gateway", 30)], at);

    const history = await listServiceHealthHistory({ sinceMinutes: 10 });
    expect(history).toHaveLength(3);
    const times = new Set(history.map(sample => sample.collectedAt.getTime()));
    // One distinct timestamp, so the three series share an x-axis point exactly.
    expect(times.size).toBe(1);
  });

  it("returns history in ascending time order", async () => {
    purge();
    const first = new Date(Date.now() - 60_000);
    const second = new Date(Date.now() - 30_000);
    await recordServiceHealthSamples([healthy("payment-engine", 10)], first);
    await recordServiceHealthSamples([healthy("payment-engine", 20)], second);

    const history = await listServiceHealthHistory({ sinceMinutes: 10, service: "payment-engine" });
    expect(history.map(sample => sample.latencyMs)).toEqual([10, 20]);
  });

  it("computes availability from recorded samples rather than assuming health", async () => {
    purge();
    await recordServiceHealthSamples([healthy("payment-engine", 10)], new Date(Date.now() - 120_000));
    await recordServiceHealthSamples(
      [{ service: "payment-engine", language: "go", status: "unreachable", reason: "timeout", latencyMs: null }],
      new Date(Date.now() - 60_000),
    );

    const [summary] = await summariseServiceAvailability(30);
    expect(summary.service).toBe("payment-engine");
    expect(summary.samples).toBe(2);
    expect(summary.healthySamples).toBe(1);
    expect(summary.availability).toBeCloseTo(0.5, 5);
    // The most recent observation, not the best one.
    expect(summary.lastStatus).toBe("unreachable");
  });

  it("reports no availability at all for a service with no samples, rather than perfect availability", async () => {
    purge();
    const summary = await summariseServiceAvailability(30);
    // No rows means no claim. A chart showing 100% here would be an invention.
    expect(summary).toEqual([]);
  });

  it("refuses at the schema level to store a healthy sample with no latency", async () => {
    purge();
    const pool = getPool();
    await expect(
      pool.query(
        `INSERT INTO service_health_samples (service, language, status, latency_ms) VALUES ('risk-compliance-core','rust','healthy',NULL)`,
      ),
    ).rejects.toThrow(/latency_coherent/);
  });

  it("refuses at the schema level to store a failure with no stated reason", async () => {
    purge();
    const pool = getPool();
    await expect(
      pool.query(
        `INSERT INTO service_health_samples (service, language, status, reason) VALUES ('risk-compliance-core','rust','unreachable','   ')`,
      ),
    ).rejects.toThrow(/reason_present/);
  });

  it.skipIf(!runApplicationRoleBoundary)("denies the application role any means of deleting or altering a recorded sample", async () => {
    purge();
    await recordServiceHealthSamples([healthy("payment-engine", 10)]);
    const pool = getPool();
    // Both are refused by grant, so a past observation cannot be rewritten
    // through the application connection.
    await expect(pool.query("DELETE FROM service_health_samples")).rejects.toThrow(/permission denied/);
    await expect(pool.query("UPDATE service_health_samples SET latency_ms = 1")).rejects.toThrow(/permission denied/);
  });
});
