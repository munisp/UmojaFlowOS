/**
 * Adversarial durability tests for the Postgres-backed multi-rail store.
 *
 * Runs against a real embedded PostgreSQL (PGlite) — not a mock — when the
 * optional dev dependency `@electric-sql/pglite` is installed and
 * PGLITE_MULTIRAIL_TEST=1 is set. Otherwise the suite skips explicitly, the
 * same gating pattern as POSTGRES_INTEGRATION_TEST. The migration DDL applied
 * here is the actual 0067 migration file, so schema drift fails the test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PostgresSubmissionRecordStore, MultiRailCoordinator, type Querier, type Rail, type Intent } from './multiRailFailover';

const ENABLED = process.env.PGLITE_MULTIRAIL_TEST === '1';

async function makeDb(): Promise<Querier | undefined> {
  if (!ENABLED) return undefined;
  let PGlite: (new () => { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }) | undefined;
  try {
    ({ PGlite } = await import('@electric-sql/pglite'));
  } catch {
    return undefined; // dependency not installed in this environment
  }
  const db = new PGlite();
  const ddl = readFileSync(join(__dirname, '../../database/postgresql/0067_multirail_submission_records.sql'), 'utf8');
  await db.query(ddl);
  return { query: (text, params) => db.query(text, params) as Promise<{ rows: never[] }> };
}

const intent: Intent = { id: 'i-1', idempotencyKey: 'k-1' };
const rail = (name: string, submit: () => Promise<{ status: 'submitted'; providerRef: string }>): Rail => ({
  name,
  submit,
  query: async () => ({ status: 'unknown' }),
});

describe('postgres multi-rail submission store (PGlite)', async () => {
  const db = await makeDb();
  if (!db) {
    it.skip('requires PGLITE_MULTIRAIL_TEST=1 and @electric-sql/pglite', () => {});
    return;
  }

  it('replays return the stored record and never resubmit — even across a coordinator restart', async () => {
    const store = new PostgresSubmissionRecordStore(db);
    let calls = 0;
    const primary = rail('yellow_card', async () => { calls++; return { status: 'submitted', providerRef: 'p-1' }; });
    const secondary = rail('bank', async () => ({ status: 'submitted', providerRef: 'b-1' }));
    const first = await new MultiRailCoordinator(store).execute(intent, primary, secondary);
    expect(first).toEqual({ rail: 'yellow_card', submission: { status: 'submitted', providerRef: 'p-1' } });
    // Simulate a full process restart: a brand-new coordinator over the same DB.
    const after = await new MultiRailCoordinator(new PostgresSubmissionRecordStore(db)).execute(intent, primary, secondary);
    expect(after).toEqual(first);
    expect(calls).toBe(1);
  });

  it('losing the insert race returns the authoritative stored record', async () => {
    const store = new PostgresSubmissionRecordStore(db);
    const winner = { rail: 'bank', submission: { status: 'submitted' as const, providerRef: 'b-9' } };
    await store.putIfAbsent('race-key', 'i-2', winner);
    const loser = await store.putIfAbsent('race-key', 'i-2', { rail: 'yellow_card', submission: { status: 'submitted', providerRef: 'p-9' } });
    expect(loser).toEqual(winner);
  });

  it('rejects an unknown outcome status at the schema level', async () => {
    const store = new PostgresSubmissionRecordStore(db);
    await expect(store.putIfAbsent('bad-status', 'i-3', { rail: 'bank', submission: { status: 'bogus' as never } }))
      .rejects.toThrow();
  });
});
