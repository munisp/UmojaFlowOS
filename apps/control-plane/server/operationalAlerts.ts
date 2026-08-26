/**
 * Operational alert evaluation for liquidity thresholds, payment failures, and
 * compliance flags, plus source-derived FX spread calculation.
 *
 * Every evaluation here follows the same discipline already proven by the
 * regulatory-deadline workflow: rows are locked for the duration of the
 * transaction, a breach is derived only from reconciled records that already
 * exist, delivery evidence is written to `notification_deliveries`, and a
 * re-run within the same evaluation window cannot deliver the same alert twice.
 *
 * No threshold is defaulted. If a corridor has no approved buffer policy, or a
 * position carries no reconciled source reference, the corridor is reported as
 * indeterminate rather than being treated as healthy.
 */
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { PoolClient } from "pg";

export type AlertActor = { subject: string; role: string };

export type Corridor = "NIGERIA_NGN" | "KENYA_KES" | "SOUTH_AFRICA_ZAR";

let pool: Pool | null = null;
function getPool(): Pool {
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

async function recordActivity(
  client: PoolClient,
  actor: AlertActor,
  action: string,
  objectType: string,
  objectId: string,
  metadata: Record<string, unknown>,
) {
  await client.query(
    `INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [actor.subject, actor.role, action, objectType, objectId, JSON.stringify(metadata)],
  );
}

/**
 * Deliver against every enabled policy for the alert type and corridor, and
 * record one delivery row per policy carrying the true outcome.
 */
async function deliver(
  client: PoolClient,
  actor: AlertActor,
  alertType: "liquidity_threshold" | "payment_failure" | "compliance_flag",
  corridor: Corridor | null,
  title: string,
  content: string,
  metadata: Record<string, unknown>,
) {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM alert_policies
      WHERE alert_type = $1 AND enabled = true AND (corridor IS NULL OR corridor::text = $2)`,
    [alertType, corridor],
  );
  const policyIds = rows.map(row => row.id);
  if (!policyIds.length) return { delivered: false, policyIds };
  const { notifyOwner } = await import("./_core/notification");
  const delivered = await notifyOwner({ title, content });
  const correlationId = randomUUID();
  const payloadHash = createHash("sha256").update(`${title}\n${content}`).digest("hex");
  for (const policyId of policyIds) {
    await client.query(
      `INSERT INTO notification_deliveries (alert_policy_id, alert_type, delivery_state, destination, correlation_id, payload_hash)
       VALUES ($1,$2,$3,'project_owner',$4,$5)`,
      [policyId, alertType, delivered ? "accepted" : "unavailable", correlationId, payloadHash],
    );
  }
  await recordActivity(client, actor, "operational_alert.delivery_attempted", "alert_delivery", correlationId, {
    ...metadata,
    alertType,
    policyIds,
    delivered,
  });
  return { delivered, policyIds };
}

/**
 * Has this exact alert already been delivered within the window? The payload
 * hash is the idempotency key, so a re-run producing identical content will not
 * notify again.
 */
async function alreadyDelivered(
  client: PoolClient,
  alertType: string,
  payloadHash: string,
  since: Date,
): Promise<boolean> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM notification_deliveries
      WHERE alert_type = $1 AND payload_hash = $2 AND created_at >= $3`,
    [alertType, payloadHash, since],
  );
  return Number(rows[0]?.count ?? "0") > 0;
}

export type LiquidityBreach = {
  corridor: Corridor;
  currency: string;
  accountReference: string;
  availableAmount: string;
  requiredMinimum: string;
  band: "amber" | "red";
  policyVersion: string;
  sourceReference: string;
};

export type LiquidityEvaluation = {
  evaluatedAt: string;
  breaches: LiquidityBreach[];
  indeterminateCorridors: Array<{ corridor: Corridor; reason: string }>;
  delivered: number;
  suppressedAsDuplicate: number;
};

/**
 * Compare each corridor's reconciled positions against its approved buffer
 * policy. A corridor with no approved policy, or with no position carrying a
 * reconciliation timestamp inside the freshness window, is reported as
 * indeterminate; it is never reported as healthy.
 */
export async function evaluatePostgresLiquidityThresholds(
  actor: AlertActor,
  options: { now?: Date; maxPositionAgeHours?: number; windowHours?: number } = {},
): Promise<LiquidityEvaluation> {
  const now = options.now ?? new Date();
  const maxAgeHours = options.maxPositionAgeHours ?? 24;
  const windowHours = options.windowHours ?? 24;
  const freshnessFloor = new Date(now.getTime() - maxAgeHours * 3_600_000);
  const windowStart = new Date(now.getTime() - windowHours * 3_600_000);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // PostgreSQL forbids FOR UPDATE with DISTINCT, so the latest effective
    // policy per corridor is selected with a window function and then locked.
    const { rows: policies } = await client.query<{
      corridor: Corridor;
      currency: string;
      policyVersion: string;
      approvedDailyOutflow: string;
      minimumBufferPct: string;
      amberBufferPct: string;
      permittedAccountKinds: string[];
    }>(
      `WITH latest AS (
         SELECT id,
                row_number() OVER (PARTITION BY corridor ORDER BY effective_from DESC) AS rank
           FROM treasury_buffer_policies
          WHERE effective_from <= $1
       )
       SELECT p.corridor::text AS corridor, p.currency, p.policy_version AS "policyVersion",
              p.approved_daily_outflow::text AS "approvedDailyOutflow",
              p.minimum_buffer_pct::text AS "minimumBufferPct",
              p.amber_buffer_pct::text AS "amberBufferPct",
              p.permitted_account_kinds AS "permittedAccountKinds"
         FROM treasury_buffer_policies p
         JOIN latest ON latest.id = p.id AND latest.rank = 1
        ORDER BY p.corridor
        FOR UPDATE OF p`,
      [now],
    );

    const breaches: LiquidityBreach[] = [];
    const indeterminate: Array<{ corridor: Corridor; reason: string }> = [];
    const corridors: Corridor[] = ["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"];
    const policyByCorridor = new Map(policies.map(policy => [policy.corridor, policy]));

    for (const corridor of corridors) {
      const policy = policyByCorridor.get(corridor);
      if (!policy) {
        indeterminate.push({ corridor, reason: "no_approved_buffer_policy" });
        continue;
      }
      const { rows: positions } = await client.query<{
        accountReference: string;
        availableAmount: string;
        sourceReference: string;
        band: "amber" | "red" | null;
        requiredMinimum: string | null;
      }>(
        `SELECT account_reference AS "accountReference",
                available_amount::text AS "availableAmount",
                source_reference AS "sourceReference",
                CASE
                  WHEN available_amount < ($5::numeric * $6::numeric) THEN 'red'
                  WHEN available_amount < ($5::numeric * $7::numeric) THEN 'amber'
                  ELSE NULL
                END AS band,
                CASE
                  WHEN available_amount < ($5::numeric * $6::numeric)
                    THEN ($5::numeric * $6::numeric)::text
                  WHEN available_amount < ($5::numeric * $7::numeric)
                    THEN ($5::numeric * $7::numeric)::text
                  ELSE NULL
                END AS "requiredMinimum"
           FROM liquidity_positions
          WHERE corridor::text = $1 AND currency = $2
            AND account_kind = ANY($3::text[])
            AND reconciled_at >= $4`,
        [
          corridor,
          policy.currency,
          policy.permittedAccountKinds,
          freshnessFloor,
          policy.approvedDailyOutflow,
          policy.minimumBufferPct,
          policy.amberBufferPct,
        ],
      );
      if (!positions.length) {
        indeterminate.push({ corridor, reason: "no_reconciled_position_within_freshness_window" });
        continue;
      }
      for (const position of positions) {
        if (!position.band || !position.requiredMinimum) continue;
        breaches.push({
          corridor,
          currency: policy.currency,
          accountReference: position.accountReference,
          availableAmount: position.availableAmount,
          requiredMinimum: position.requiredMinimum,
          band: position.band,
          policyVersion: policy.policyVersion,
          sourceReference: position.sourceReference,
        });
      }
    }

    let delivered = 0;
    let suppressed = 0;
    for (const breach of breaches) {
      const title = `UmojaFlowOS ${breach.corridor} liquidity buffer ${breach.band.toUpperCase()}`;
      const content =
        `Account ${breach.accountReference} holds ${breach.availableAmount} ${breach.currency}, ` +
        `below the ${breach.band} floor of ${breach.requiredMinimum} under policy ${breach.policyVersion}. ` +
        `Reconciled source: ${breach.sourceReference}. This alert initiates no transfer.`;
      const payloadHash = createHash("sha256").update(`${title}\n${content}`).digest("hex");
      if (await alreadyDelivered(client, "liquidity_threshold", payloadHash, windowStart)) {
        suppressed += 1;
        continue;
      }
      const result = await deliver(client, actor, "liquidity_threshold", breach.corridor, title, content, {
        accountReference: breach.accountReference,
        band: breach.band,
        policyVersion: breach.policyVersion,
      });
      if (result.policyIds.length) delivered += 1;
    }

    await recordActivity(client, actor, "liquidity_threshold.evaluated", "alert_evaluation", randomUUID(), {
      evaluatedAt: now.toISOString(),
      breachCount: breaches.length,
      indeterminate,
      delivered,
      suppressedAsDuplicate: suppressed,
    });
    await client.query("COMMIT");
    return {
      evaluatedAt: now.toISOString(),
      breaches,
      indeterminateCorridors: indeterminate,
      delivered,
      suppressedAsDuplicate: suppressed,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type PaymentFailureEvaluation = {
  evaluatedAt: string;
  failedOrders: Array<{ orderId: string; corridor: Corridor; idempotencyKey: string }>;
  delivered: number;
  suppressedAsDuplicate: number;
};

/**
 * Notify on payment orders that reached a failed state within the window. The
 * failure itself is never inferred here: only orders already recorded as failed
 * by the lifecycle are considered.
 */
export async function evaluatePostgresPaymentFailures(
  actor: AlertActor,
  options: { now?: Date; windowHours?: number } = {},
): Promise<PaymentFailureEvaluation> {
  const now = options.now ?? new Date();
  const windowHours = options.windowHours ?? 24;
  const windowStart = new Date(now.getTime() - windowHours * 3_600_000);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; corridor: Corridor; idempotencyKey: string }>(
      `SELECT id, corridor::text AS corridor, idempotency_key AS "idempotencyKey"
         FROM payment_orders
        WHERE status = 'failed' AND updated_at >= $1
        ORDER BY updated_at DESC
        FOR UPDATE`,
      [windowStart],
    );

    let delivered = 0;
    let suppressed = 0;
    for (const order of rows) {
      const title = `UmojaFlowOS ${order.corridor} payment failure`;
      const content =
        `Payment order ${order.id} (idempotency key ${order.idempotencyKey}) is recorded as failed. ` +
        `Review the recorded provider finality reference and the order's audit trail. This alert retries nothing.`;
      const payloadHash = createHash("sha256").update(`${title}\n${content}`).digest("hex");
      if (await alreadyDelivered(client, "payment_failure", payloadHash, windowStart)) {
        suppressed += 1;
        continue;
      }
      const result = await deliver(client, actor, "payment_failure", order.corridor, title, content, {
        orderId: order.id,
        idempotencyKey: order.idempotencyKey,
      });
      if (result.policyIds.length) delivered += 1;
    }

    await recordActivity(client, actor, "payment_failure.evaluated", "alert_evaluation", randomUUID(), {
      evaluatedAt: now.toISOString(),
      failedCount: rows.length,
      delivered,
      suppressedAsDuplicate: suppressed,
    });
    await client.query("COMMIT");
    return {
      evaluatedAt: now.toISOString(),
      failedOrders: rows.map(row => ({ orderId: row.id, corridor: row.corridor, idempotencyKey: row.idempotencyKey })),
      delivered,
      suppressedAsDuplicate: suppressed,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type ComplianceFlagEvaluation = {
  evaluatedAt: string;
  openCases: Array<{ caseId: string; caseType: string; openedAt: string }>;
  delivered: number;
  suppressedAsDuplicate: number;
};

/**
 * Notify on compliance cases that remain open beyond the review threshold. The
 * alert conveys that a case awaits human review; it never proposes or implies a
 * disposition.
 */
export async function evaluatePostgresComplianceFlags(
  actor: AlertActor,
  options: { now?: Date; ageHours?: number; windowHours?: number } = {},
): Promise<ComplianceFlagEvaluation> {
  const now = options.now ?? new Date();
  const ageHours = options.ageHours ?? 48;
  const windowHours = options.windowHours ?? 24;
  const ageFloor = new Date(now.getTime() - ageHours * 3_600_000);
  const windowStart = new Date(now.getTime() - windowHours * 3_600_000);

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; caseType: string; openedAt: Date }>(
      `SELECT id, case_type AS "caseType", opened_at AS "openedAt"
         FROM compliance_cases
        WHERE status = 'open' AND opened_at <= $1
        ORDER BY opened_at ASC
        FOR UPDATE`,
      [ageFloor],
    );

    let delivered = 0;
    let suppressed = 0;
    for (const complianceCase of rows) {
      const title = "UmojaFlowOS compliance case awaiting review";
      const content =
        `Case ${complianceCase.id} of type ${complianceCase.caseType} has been open since ` +
        `${complianceCase.openedAt.toISOString()} and still awaits a compliance-officer disposition. ` +
        `This alert records no finding and proposes no disposition.`;
      const payloadHash = createHash("sha256").update(`${title}\n${content}`).digest("hex");
      if (await alreadyDelivered(client, "compliance_flag", payloadHash, windowStart)) {
        suppressed += 1;
        continue;
      }
      const result = await deliver(client, actor, "compliance_flag", null, title, content, {
        caseId: complianceCase.id,
        caseType: complianceCase.caseType,
      });
      if (result.policyIds.length) delivered += 1;
    }

    await recordActivity(client, actor, "compliance_flag.evaluated", "alert_evaluation", randomUUID(), {
      evaluatedAt: now.toISOString(),
      openCaseCount: rows.length,
      ageHours,
      delivered,
      suppressedAsDuplicate: suppressed,
    });
    await client.query("COMMIT");
    return {
      evaluatedAt: now.toISOString(),
      openCases: rows.map(row => ({
        caseId: row.id,
        caseType: row.caseType,
        openedAt: row.openedAt.toISOString(),
      })),
      delivered,
      suppressedAsDuplicate: suppressed,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type SpreadResult = {
  baseAsset: string;
  quoteAsset: string;
  bid: string;
  ask: string;
  mid: string;
  spreadBasisPoints: string;
  observationCount: number;
  sourceReferences: string[];
  windowStart: string;
  windowEnd: string;
};

/**
 * Derive bid, ask, mid, and spread from recorded observations for a pair.
 *
 * The spread is the observed dispersion across independent sources inside the
 * window: the lowest recorded rate is the bid, the highest is the ask. No
 * default or assumed spread is ever applied, and a pair with fewer than two
 * independent sources returns null rather than a fabricated single-source
 * spread of zero.
 *
 * The window is evaluated entirely inside PostgreSQL rather than against a
 * JavaScript `Date`. PostgreSQL stores timestamps at microsecond precision
 * while a JavaScript `Date` holds only milliseconds, so round-tripping the
 * upper bound through the driver truncates it and can silently exclude the most
 * recent observation. Excluding a source would understate the observed
 * dispersion, which is exactly the kind of quiet inaccuracy this platform must
 * not produce.
 */
export async function computePostgresFxSpread(
  baseAsset: string,
  quoteAsset: string,
  options: { now?: Date; windowMinutes?: number; sourcePrefix?: string } = {},
): Promise<SpreadResult | null> {
  const windowMinutes = options.windowMinutes ?? 60;

  const client = await getPool().connect();
  try {
    // `sourcePrefix` narrows the calculation to one recorded source family. It
    // is used by regressions to isolate their own observations; production
    // callers omit it and see every recorded source for the pair.
    //
    // The anchor is `clock_timestamp()` evaluated server-side (or the caller's
    // pinned instant), so the bounds keep full microsecond precision.
    const { rows } = await client.query<{
      rate: string;
      sourceReference: string;
      windowStart: Date;
      windowEnd: Date;
    }>(
      `WITH bounds AS (
         SELECT COALESCE($3::timestamptz, clock_timestamp()) AS window_end
       )
       SELECT m.rate::text AS rate,
              m.source_reference AS "sourceReference",
              bounds.window_end - make_interval(mins => $4::int) AS "windowStart",
              bounds.window_end AS "windowEnd"
         FROM market_observations m
         CROSS JOIN bounds
        WHERE m.base_asset = $1 AND m.quote_asset = $2
          AND m.observed_at >= bounds.window_end - make_interval(mins => $4::int)
          AND m.observed_at <= bounds.window_end
          AND ($5::text IS NULL OR m.source_reference LIKE $5 || '%')`,
      [
        baseAsset,
        quoteAsset,
        options.now ?? null,
        windowMinutes,
        options.sourcePrefix ?? null,
      ],
    );
    const distinctSources = new Set(rows.map(row => row.sourceReference));
    if (rows.length < 2 || distinctSources.size < 2) return null;

    const rates = rows.map(row => Number(row.rate)).sort((a, b) => a - b);
    const bid = rates[0];
    const ask = rates[rates.length - 1];
    const mid = (bid + ask) / 2;
    const spreadBasisPoints = ((ask - bid) / mid) * 10_000;

    return {
      baseAsset,
      quoteAsset,
      bid: bid.toString(),
      ask: ask.toString(),
      mid: mid.toString(),
      spreadBasisPoints: spreadBasisPoints.toFixed(4),
      observationCount: rows.length,
      sourceReferences: Array.from(distinctSources).sort(),
      windowStart: rows[0].windowStart.toISOString(),
      windowEnd: rows[0].windowEnd.toISOString(),
    };
  } finally {
    client.release();
  }
}
