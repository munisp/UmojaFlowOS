import { getPool } from "./postgres";
import type { ServiceStatus } from "./serviceHealth";

/**
 * Persistence and retrieval of service health samples.
 *
 * The central rule here is that a sample records what was observed, including
 * the observation that nothing could be observed. An unreachable service is
 * stored with its reason rather than skipped, because a skipped collection and
 * a failed collection look identical in a chart, and only one of them is an
 * incident.
 */

export type ServiceHealthSample = {
  id: string;
  service: string;
  language: string;
  status: "healthy" | "unreachable" | "not_configured";
  latencyMs: number | null;
  uptimeSeconds: number | null;
  counters: Record<string, number>;
  posture: Record<string, string>;
  reason: string | null;
  collectedAt: Date;
  serviceObservedAt: Date | null;
};

/**
 * Writes one collection round.
 *
 * All statuses in a round share a single `collectedAt`, so samples from the
 * same round line up exactly on a shared time axis. Deriving each row's
 * timestamp from its own insert would scatter a round across a few
 * milliseconds and make two services' series impossible to compare precisely.
 */
export async function recordServiceHealthSamples(
  statuses: ServiceStatus[],
  collectedAt: Date = new Date(),
): Promise<number> {
  if (statuses.length === 0) return 0;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    let written = 0;
    for (const status of statuses) {
      const healthy = status.status === "healthy";
      await client.query(
        `INSERT INTO service_health_samples
           (service, language, status, latency_ms, uptime_seconds, counters, posture, reason, collected_at, service_observed_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`,
        [
          status.service,
          status.language,
          status.status,
          healthy ? status.latencyMs : status.status === "unreachable" ? null : null,
          healthy ? status.uptimeSeconds : null,
          JSON.stringify(healthy ? status.counters : {}),
          JSON.stringify(healthy ? status.posture : {}),
          healthy ? null : status.reason,
          collectedAt,
          healthy && status.observedAt ? new Date(status.observedAt) : null,
        ],
      );
      written += 1;
    }
    await client.query("COMMIT");
    return written;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reads the recorded history for charting.
 *
 * Returns samples in ascending time order because that is the order a chart
 * plots them in, and sorting in the browser would be a second place for the
 * ordering to be got wrong.
 */
export async function listServiceHealthHistory(input: {
  sinceMinutes?: number;
  service?: string;
  limit?: number;
} = {}): Promise<ServiceHealthSample[]> {
  const sinceMinutes = Math.min(Math.max(input.sinceMinutes ?? 60, 1), 60 * 24 * 30);
  const limit = Math.min(Math.max(input.limit ?? 2000, 1), 20000);
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<ServiceHealthSample>(
      `SELECT id,
              service,
              language,
              status,
              latency_ms AS "latencyMs",
              uptime_seconds AS "uptimeSeconds",
              counters,
              posture,
              reason,
              collected_at AS "collectedAt",
              service_observed_at AS "serviceObservedAt"
         FROM service_health_samples
        WHERE collected_at >= now() - ($1 || ' minutes')::interval
          AND ($2::text IS NULL OR service = $2)
        ORDER BY collected_at ASC, service ASC
        LIMIT $3`,
      [String(sinceMinutes), input.service ?? null, limit],
    );
    return rows.map((row: ServiceHealthSample) => ({
      ...row,
      // pg returns bigint as string to avoid precision loss; a uptime in
      // seconds is far inside the safe range, so converting is correct here.
      uptimeSeconds: row.uptimeSeconds === null ? null : Number(row.uptimeSeconds),
    }));
  } finally {
    client.release();
  }
}

/**
 * Availability over a window, computed from recorded samples only.
 *
 * Returns null rather than 100% when there are no samples. A service with no
 * recorded history has unknown availability, and reporting that as perfect
 * would be a fabrication of exactly the kind this platform refuses elsewhere.
 */
export async function summariseServiceAvailability(sinceMinutes = 60): Promise<
  Array<{
    service: string;
    language: string;
    samples: number;
    healthySamples: number;
    availability: number | null;
    medianLatencyMs: number | null;
    lastStatus: string;
    lastCollectedAt: Date;
  }>
> {
  const window = Math.min(Math.max(sinceMinutes, 1), 60 * 24 * 30);
  const client = await getPool().connect();
  try {
    const { rows } = await client.query<{
      service: string;
      language: string;
      samples: number;
      healthySamples: number;
      medianLatencyMs: string | number | null;
      lastStatus: string;
      lastCollectedAt: Date;
    }>(
      `WITH windowed AS (
         SELECT * FROM service_health_samples
          WHERE collected_at >= now() - ($1 || ' minutes')::interval
       ), latest AS (
         SELECT DISTINCT ON (service) service, status, collected_at
           FROM windowed ORDER BY service, collected_at DESC
       )
       SELECT w.service,
              max(w.language) AS language,
              count(*)::int AS samples,
              count(*) FILTER (WHERE w.status='healthy')::int AS "healthySamples",
              percentile_cont(0.5) WITHIN GROUP (ORDER BY w.latency_ms)
                FILTER (WHERE w.latency_ms IS NOT NULL) AS "medianLatencyMs",
              l.status AS "lastStatus",
              l.collected_at AS "lastCollectedAt"
         FROM windowed w
         JOIN latest l ON l.service = w.service
        GROUP BY w.service, l.status, l.collected_at
        ORDER BY w.service`,
      [String(window)],
    );
    return rows.map(row => ({
      service: row.service,
      language: row.language,
      samples: row.samples,
      healthySamples: row.healthySamples,
      availability: row.samples > 0 ? row.healthySamples / row.samples : null,
      medianLatencyMs: row.medianLatencyMs === null ? null : Number(row.medianLatencyMs),
      lastStatus: row.lastStatus,
      lastCollectedAt: row.lastCollectedAt,
    }));
  } finally {
    client.release();
  }
}
