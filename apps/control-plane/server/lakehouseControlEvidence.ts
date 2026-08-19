import { getPool } from "./postgres";

type OutboxRow = {
  id: string;
  source: "postgresql_control";
  event_type: string;
  correlation_sha256: string;
  observed_at: Date;
  outcome: string;
  corridor: "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR" | null;
};

type DispatchConfiguration = { endpoint: URL; token: string } | { unavailable: "not_configured" | "invalid_configuration" };

function dispatchConfiguration(): DispatchConfiguration {
  const endpointValue = process.env.UMOJA_LAKEHOUSE_CATALOG_URL;
  const token = process.env.UMOJA_LAKEHOUSE_POSTGRESQL_CONTROL_TOKEN;
  if (!endpointValue || !token) return { unavailable: "not_configured" };
  try {
    const endpoint = new URL(endpointValue);
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
    if (endpoint.username || endpoint.password || (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback))) {
      return { unavailable: "invalid_configuration" };
    }
    return { endpoint, token };
  } catch {
    return { unavailable: "invalid_configuration" };
  }
}

function shortError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // The endpoint and token are configuration, not evidence. Avoid preserving
  // either in the canonical outbox after a network failure.
  return message.replace(/https?:\/\/[^\s]+/g, "[endpoint]").slice(0, 300);
}

/**
 * The scheduled path calls this without a scope and drains pending evidence in
 * creation order. A caller that already holds a redacted correlation may scope
 * an incident-recovery replay to that one immutable projection; it cannot
 * broaden authority or alter canonical control data.
 */
export async function drainLakehouseControlEvidence(limit = 25, correlationSha256?: string) {
  const configuration = dispatchConfiguration();
  if ("unavailable" in configuration) return { status: configuration.unavailable, delivered: 0, pending: 0, failed: 0 } as const;
  const bounded = Math.max(1, Math.min(limit, 100));
  const client = await getPool().connect();
  let delivered = 0;
  let failed = 0;
  let pending = 0;
  const attemptedIds: string[] = [];
  try {
    for (let index = 0; index < bounded; index += 1) {
      await client.query("BEGIN");
      try {
        const selected = await client.query<OutboxRow>(
          `SELECT id, source, event_type, correlation_sha256, observed_at, outcome, corridor
            FROM control_evidence_outbox
            WHERE delivery_state = 'pending'
              AND NOT (id = ANY($1::uuid[]))
              AND ($2::char(64) IS NULL OR correlation_sha256 = $2::char(64))
            ORDER BY created_at
            LIMIT 1 FOR UPDATE SKIP LOCKED`,
          [attemptedIds, correlationSha256 ?? null],
        );
        const row = selected.rows[0];
        if (!row) {
          await client.query("COMMIT");
          break;
        }
        attemptedIds.push(row.id);
        pending += 1;
        const endpoint = new URL("/v1/lakehouse/catalog/postgresql_control", configuration.endpoint);
        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${configuration.token}` },
            body: JSON.stringify({
              source: row.source,
              event_type: row.event_type,
              observed_at: row.observed_at.toISOString(),
              correlation_sha256: row.correlation_sha256,
              outcome: row.outcome,
              ...(row.corridor ? { corridor: row.corridor } : {}),
            }),
            signal: AbortSignal.timeout(5_000),
          });
          if (!response.ok) throw new Error(`catalog delivery returned status ${response.status}`);
          await client.query(
            `UPDATE control_evidence_outbox
                SET delivery_state='delivered', delivery_attempts=delivery_attempts+1,
                    last_delivery_error=NULL, delivered_at=now()
              WHERE id=$1`,
            [row.id],
          );
          delivered += 1;
        } catch (error) {
          await client.query(
            `UPDATE control_evidence_outbox
                SET delivery_attempts=delivery_attempts+1, last_delivery_error=$2
              WHERE id=$1`,
            [row.id, shortError(error)],
          );
          failed += 1;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    return { status: "completed", delivered, pending, failed } as const;
  } finally {
    client.release();
  }
}
