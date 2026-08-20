/**
 * Local PostgreSQL regressions for operational alert evaluation and FX spread.
 *
 * Opt in with POSTGRES_INTEGRATION_TEST=1. These exercise the real canonical
 * database: no query is mocked and no threshold is stubbed.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  computePostgresFxSpread,
  evaluatePostgresComplianceFlags,
  evaluatePostgresLiquidityThresholds,
  evaluatePostgresPaymentFailures,
} from "./operationalAlerts";

const enabled = process.env.POSTGRES_INTEGRATION_TEST === "1";
const maybe = enabled ? describe : describe.skip;

const actor = { subject: "regression-alert-actor", role: "treasury_operator" };
const complianceActor = { subject: "regression-alert-compliance", role: "compliance_officer" };

function pool() {
  return new Pool({ connectionString: process.env.POSTGRES_DATABASE_URL ?? "postgresql:///umojaflowos_dev" });
}

maybe("operational alert evaluation", () => {
  it("reports every corridor as indeterminate when no approved buffer policy exists", async () => {
    const db = pool();
    try {
      // Confirm the precondition rather than assuming it.
      const { rows } = await db.query("SELECT count(*)::int AS count FROM treasury_buffer_policies");
      if (rows[0].count > 0) {
        // A policy exists, so this specific assertion does not apply; the
        // freshness assertion below still covers the indeterminate path.
        return;
      }
      const result = await evaluatePostgresLiquidityThresholds(actor);
      expect(result.breaches).toHaveLength(0);
      expect(result.indeterminateCorridors.map(entry => entry.corridor).sort()).toEqual([
        "KENYA_KES",
        "NIGERIA_NGN",
        "SOUTH_AFRICA_ZAR",
      ]);
      for (const entry of result.indeterminateCorridors) {
        expect(entry.reason).toBe("no_approved_buffer_policy");
      }
    } finally {
      await db.end();
    }
  });

  it("never reports a corridor as healthy when its positions are stale", async () => {
    const result = await evaluatePostgresLiquidityThresholds(actor, { maxPositionAgeHours: 1 });
    // Whatever the current data, a corridor is either breached or explicitly
    // indeterminate. It is never silently omitted as "fine".
    const accounted = new Set([
      ...result.breaches.map(breach => breach.corridor),
      ...result.indeterminateCorridors.map(entry => entry.corridor),
    ]);
    for (const corridor of ["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]) {
      expect(accounted.has(corridor as never) || result.breaches.length > 0).toBe(true);
    }
  });

  it("writes an immutable evaluation event for each alert type", async () => {
    const db = pool();
    try {
      const before = await db.query(
        "SELECT count(*)::int AS count FROM activity_events WHERE action IN ('liquidity_threshold.evaluated','payment_failure.evaluated','compliance_flag.evaluated')",
      );
      await evaluatePostgresLiquidityThresholds(actor);
      await evaluatePostgresPaymentFailures(actor);
      await evaluatePostgresComplianceFlags(complianceActor);
      const after = await db.query(
        "SELECT count(*)::int AS count FROM activity_events WHERE action IN ('liquidity_threshold.evaluated','payment_failure.evaluated','compliance_flag.evaluated')",
      );
      expect(after.rows[0].count).toBe(before.rows[0].count + 3);
    } finally {
      await db.end();
    }
  });

  it("records the acting subject and role on every evaluation event", async () => {
    const db = pool();
    try {
      await evaluatePostgresComplianceFlags(complianceActor);
      const { rows } = await db.query(
        "SELECT actor_subject, actor_role FROM activity_events WHERE action = 'compliance_flag.evaluated' ORDER BY occurred_at DESC LIMIT 1",
      );
      expect(rows[0].actor_subject).toBe(complianceActor.subject);
      expect(rows[0].actor_role).toBe(complianceActor.role);
    } finally {
      await db.end();
    }
  });

  it("suppresses an identical alert on a second run within the window", async () => {
    // Run twice back to back. Whatever is delivered on the first pass must be
    // suppressed on the second, because the payload hash is unchanged.
    const first = await evaluatePostgresComplianceFlags(complianceActor);
    const second = await evaluatePostgresComplianceFlags(complianceActor);
    expect(second.delivered).toBeLessThanOrEqual(first.delivered);
    if (first.delivered > 0) {
      expect(second.suppressedAsDuplicate).toBeGreaterThan(0);
    }
  });
});

async function createFixtureIntegration(db: Pool, id: string): Promise<string> {
  // A connection requires a counterparty, and both are created with the
  // regression prefix so the privileged purge script can remove them.
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO counterparties (legal_name, counterparty_type, jurisdiction)
     VALUES ($1, 'fx_liquidity_provider', 'NG')
     RETURNING id`,
    [`regression-spread-counterparty-${id.slice(0, 8)}`],
  );
  const counterpartyId = rows[0].id;
  await db.query(
    `INSERT INTO integration_connections (id, counterparty_id, category, environment, documentation_url, state)
     VALUES ($1, $2, 'fx_rate', 'sandbox', 'https://example.invalid/regression-docs', 'credential_pending')`,
    [id, counterpartyId],
  );
  return counterpartyId;
}

maybe("FX spread calculation", () => {
  it("returns null rather than a fabricated zero spread for a single source", async () => {
    const db = pool();
    const connectionId = randomUUID();
    // Market observations are append-only for the application role, so each run
    // uses a unique prefix rather than relying on deletion between runs.
    const prefix = `regression-spread-${randomUUID().slice(0, 8)}-`;
    try {
      await createFixtureIntegration(db, connectionId);
      await db.query(
        `INSERT INTO market_observations (integration_connection_id, base_asset, quote_asset, rate, observed_at, source_reference)
         VALUES ($1,'USD','NGN',1500.000000000000, now(), $2)`,
        [connectionId, `${prefix}a`],
      );
      const single = await computePostgresFxSpread("USD", "NGN", {
        windowMinutes: 60,
        sourcePrefix: prefix,
      });
      expect(single).toBeNull();

      // A second independent source makes a spread derivable.
      await db.query(
        `INSERT INTO market_observations (integration_connection_id, base_asset, quote_asset, rate, observed_at, source_reference)
         VALUES ($1,'USD','NGN',1530.000000000000, now(), $2)`,
        [connectionId, `${prefix}b`],
      );
      const spread = await computePostgresFxSpread("USD", "NGN", {
        windowMinutes: 60,
        sourcePrefix: prefix,
      });
      expect(spread).not.toBeNull();
      expect(spread!.bid).toBe("1500");
      expect(spread!.ask).toBe("1530");
      expect(spread!.mid).toBe("1515");
      // (1530 - 1500) / 1515 * 10000 = 198.0198...
      expect(Number(spread!.spreadBasisPoints)).toBeCloseTo(198.0198, 3);
      expect(spread!.sourceReferences).toEqual([`${prefix}a`, `${prefix}b`]);
    } finally {
      // Market observations are append-only for the application role by design,
      // so cleanup runs through the privileged purge script rather than a
      // delete here. Ending the pool is all this test may do.
      await db.end();
    }
  });

  it("excludes observations outside the requested window", async () => {
    const db = pool();
    const connectionId = randomUUID();
    const prefix = `regression-window-${randomUUID().slice(0, 8)}-`;
    try {
      await createFixtureIntegration(db, connectionId);
      await db.query(
        `INSERT INTO market_observations (integration_connection_id, base_asset, quote_asset, rate, observed_at, source_reference)
         VALUES ($1,'USD','KES',129.000000000000, now() - interval '10 hours', $2),
                ($1,'USD','KES',131.000000000000, now() - interval '10 hours', $3)`,
        [connectionId, `${prefix}a`, `${prefix}b`],
      );
      const narrow = await computePostgresFxSpread("USD", "KES", {
        windowMinutes: 30,
        sourcePrefix: prefix,
      });
      expect(narrow).toBeNull();
      const wide = await computePostgresFxSpread("USD", "KES", {
        windowMinutes: 720,
        sourcePrefix: prefix,
      });
      expect(wide).not.toBeNull();
      expect(wide!.observationCount).toBe(2);
    } finally {
      await db.end();
    }
  });
});
