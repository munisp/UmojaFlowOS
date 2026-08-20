/**
 * Reconciliation regressions for the MySQL-to-PostgreSQL cutover.
 *
 * These run the real executor in dry-run mode against the real local PostgreSQL
 * schema and the real transitional MySQL/TiDB source. A dry run performs the
 * load inside a transaction and rolls it back, so reconciliation exercises the
 * genuine mapping, loading, and checksum comparison without persisting anything.
 *
 * Opt in with POSTGRES_INTEGRATION_TEST=1.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM harness, intentionally untyped
import { countFixtureRows, runFixtureBackedDryRun } from "../scripts/postgres/cutover-fixture-harness.mjs";
import { deterministicUuid } from "../scripts/postgres/cutover-lib.mjs";

const execFileAsync = promisify(execFile);
const enabled = process.env.POSTGRES_INTEGRATION_TEST === "1";
const suite = enabled ? describe : describe.skip;

const EXPECTED_TABLE_MAP = {
  users: "user_role_assignments",
  counterparties: "counterparties",
  integrationConnections: "integration_connections",
  marketObservations: "market_observations",
  counterpartyAuthorizations: "counterparty_authorizations",
  customers: "customers",
  beneficiaries: "beneficiaries",
  paymentOrders: "payment_orders",
  paymentLegs: "payment_legs",
  rateLocks: "rate_locks",
  liquidityPositions: "liquidity_positions",
};

async function runDryRun(extraEnv = {}) {
  return execFileAsync("node", ["scripts/postgres/migrate-transition.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, MIGRATION_DRY_RUN: "1", MIGRATION_INITIATED_BY: "cutover-reconciliation-regression", ...extraEnv },
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function countRows(table) {
  const client = new pg.Client({ connectionString: process.env.POSTGRES_DATABASE_URL ?? "postgresql:///umojaflowos_dev" });
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
    return rows[0].count;
  } finally {
    await client.end();
  }
}

suite("cutover reconciliation", () => {
  it("reconciles every mapped table against the real target schema", async () => {
    const { stdout } = await runDryRun();
    const report = JSON.parse(stdout);
    expect(report.migrated).toBe(false);
    const actual = Object.fromEntries(report.reconciliations.map(entry => [entry.sourceTable, entry.destinationTable]));
    expect(actual).toEqual(EXPECTED_TABLE_MAP);
    // Every reconciliation must carry a real checksum, not an empty placeholder.
    for (const entry of report.reconciliations) {
      expect(entry.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(typeof entry.sourceCount).toBe("number");
    }
  }, 120_000);

  it("persists nothing during a dry run", async () => {
    const before = {
      roles: await countRows("user_role_assignments"),
      runs: await countRows("postgres_cutover_runs"),
      reconciliations: await countRows("postgres_cutover_table_reconciliations"),
    };
    await runDryRun();
    expect({
      roles: await countRows("user_role_assignments"),
      runs: await countRows("postgres_cutover_runs"),
      reconciliations: await countRows("postgres_cutover_table_reconciliations"),
    }).toEqual(before);
  }, 120_000);

  it("produces a stable snapshot hash across repeated read-only runs", async () => {
    const first = JSON.parse((await runDryRun()).stdout);
    const second = JSON.parse((await runDryRun()).stdout);
    expect(first.sourceSnapshotSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.sourceSnapshotSha256).toBe(first.sourceSnapshotSha256);
  }, 180_000);

  it("blocks an apply whose approved snapshot hash does not match", async () => {
    await expect(
      execFileAsync("node", ["scripts/postgres/migrate-transition.mjs"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MIGRATION_DRY_RUN: "0",
          MIGRATION_EXECUTION_APPROVED: "1",
          MIGRATION_INITIATED_BY: "cutover-reconciliation-regression",
          MIGRATION_APPROVED_SOURCE_SNAPSHOT_SHA256: "0".repeat(64),
        },
        maxBuffer: 8 * 1024 * 1024,
      }),
    ).rejects.toThrow(/must exactly match the current read-only source snapshot/);
  }, 120_000);

  it("reports no unsupported non-empty transitional table", async () => {
    const report = JSON.parse((await runDryRun()).stdout);
    // If a transitional table gains rows without an approved mapping, the
    // executor must block rather than silently skip it.
    expect(report.unsupportedBusinessTablesBlocked).toEqual([]);
  }, 120_000);
});

/**
 * Non-empty business-row proof.
 *
 * The transitional source currently holds no business records, so zero-row
 * reconciliation alone cannot prove the mapping, FK ordering, and normalization
 * logic. This suite commits one fixture row per mapped table, runs the real
 * executor, then removes them. It lives in this file deliberately: while it runs
 * the shared source snapshot changes, so it must never execute in parallel with
 * the snapshot-stability assertions above.
 */
const nonEmptyTables = [
  "counterparties",
  "counterpartyAuthorizations",
  "integrationConnections",
  "marketObservations",
  "customers",
  "beneficiaries",
  "paymentOrders",
  "paymentLegs",
  "rateLocks",
  "liquidityPositions",
];

suite("cutover with non-empty business rows", () => {
  let report: any;
  const reportOnce = async () => {
    if (!report) report = await runFixtureBackedDryRun();
    return report;
  };

  afterAll(async () => {
    // The harness removes its own rows; assert the source really is clean again.
    expect(await countFixtureRows()).toBe(0);
  });

  it("migrates and reconciles exactly one row for every mapped business table", async () => {
    const result = await reportOnce();
    const byTable = Object.fromEntries(result.reconciliations.map((entry: any) => [entry.sourceTable, entry]));
    for (const table of nonEmptyTables) {
      expect(byTable[table], `missing reconciliation for ${table}`).toBeDefined();
      expect(byTable[table].sourceCount, `${table} did not migrate its fixture row`).toBe(1);
      expect(byTable[table].checksum).toMatch(/^[a-f0-9]{64}$/);
    }
  }, 180_000);

  it("reports the fixture rows in the source table counts and skips nothing", async () => {
    const result = await reportOnce();
    for (const table of nonEmptyTables) expect(result.businessTableCounts[table], `${table} count`).toBe(1);
    expect(result.unsupportedBusinessTablesBlocked).toEqual([]);
  }, 180_000);

  it("derives stable, table-scoped deterministic UUIDs for migrated identifiers", () => {
    const first = deterministicUuid("counterparties", 900001);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(deterministicUuid("counterparties", 900001)).toBe(first);
    // The same legacy integer under a different table must not collide.
    expect(deterministicUuid("customers", 900001)).not.toBe(first);
  });

  it("persists nothing in PostgreSQL after the fixture-backed run", async () => {
    const result = await reportOnce();
    expect(result.migrated).toBe(false);
    // Other suites legitimately create their own rows in these tables, so assert
    // specifically that no fixture-derived record survived the rolled-back load.
    expect(await countRows("counterparties WHERE legal_name LIKE 'CUTOVER-FIXTURE%'")).toBe(0);
    expect(await countRows("payment_orders WHERE idempotency_key LIKE 'CUTOVER-FIXTURE%'")).toBe(0);
    expect(await countRows("liquidity_positions WHERE source_reference LIKE 'CUTOVER-FIXTURE%'")).toBe(0);
  }, 180_000);
});
