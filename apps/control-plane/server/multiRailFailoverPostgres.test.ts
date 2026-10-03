/**
 * Adversarial PGlite tests for the durable multirail submission store.
 *
 * Gated: only runs when PGLITE_MULTIRAIL_TEST=1 and @electric-sql/pglite is
 * installed (mirrors the POSTGRES_INTEGRATION_TEST pattern). Applies the
 * real migration DDL from database/postgresql/0067_multirail_submission_records.sql.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ENABLED = process.env.PGLITE_MULTIRAIL_TEST === "1";

async function loadStore() {
  const { PGlite } = await import("@electric-sql/pglite");
  const mod = await import("./multiRailFailover");
  const db = new PGlite();
  const ddl = readFileSync(
    join(__dirname, "../../../database/postgresql/0067_multirail_submission_records.sql"),
    "utf8",
  );
  await db.query(ddl);
  const querier = { query: (text: string, params?: unknown[]) => db.query(text, params) };
  return { db, store: new mod.PostgresSubmissionRecordStore(querier as never), mod };
}

describe("PostgresSubmissionRecordStore (PGlite)", () => {
  const runner = ENABLED ? it : it.skip;

  runner("restart simulation: replay returns stored record without resubmitting", async () => {
    const { store, mod } = await loadStore();
    let calls = 0;
    const rails = [{
      name: "rail-a",
      submit: async () => {
        calls += 1;
        return { status: "submitted" as const, providerRef: "ref-1" };
      },
    }];
    const first = await new mod.MultiRailCoordinator(store).execute("intent-1", "key-1", rails as never);
    expect(first.status).toBe("submitted");
    // Simulate restart: brand-new coordinator over the same durable store.
    const second = await new mod.MultiRailCoordinator(store).execute("intent-1", "key-1", rails as never);
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  runner("insert race: loser receives the winner's authoritative record", async () => {
    const { store } = await loadStore();
    const winner = {
      idempotencyKey: "key-race",
      intentId: "intent-w",
      rail: "rail-winner",
      status: "submitted" as const,
      providerRef: "w1",
      safeToRetry: null,
    };
    const loser = {
      idempotencyKey: "key-race",
      intentId: "intent-l",
      rail: "rail-loser",
      status: "failed" as const,
      providerRef: "l1",
      safeToRetry: true,
    };
    const a = await store.putIfAbsent(winner as never);
    const b = await store.putIfAbsent(loser as never);
    expect(a.rail).toBe("rail-winner");
    expect(b).toEqual(a);
  });

  runner("schema rejects bogus status values", async () => {
    const { db } = await loadStore();
    await expect(
      db.query(
        "INSERT INTO multirail_submission_records (idempotency_key, intent_id, rail, status) VALUES ($1, $2, $3, $4)",
        ["k", "i", "r", "bogus"],
      ),
    ).rejects.toThrow();
  });
});
