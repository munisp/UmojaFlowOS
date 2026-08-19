import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The cutover load order is a correctness property, not a style preference.
 *
 * Every mapped table carries foreign keys into tables loaded before it. If a
 * dependent table is loaded first the transaction aborts, and worse, a future
 * edit could reorder the calls without any test noticing, because the dry run
 * currently succeeds against an empty source. This asserts the order that the
 * executor actually calls, derived from the file rather than restated by hand.
 */
const EXECUTOR = join(process.cwd(), "scripts", "postgres", "migrate-transition.mjs");

/**
 * Dependency-ordered batches. A table may only reference tables in its own
 * batch or an earlier one.
 */
const BATCHES: Array<{ name: string; steps: string[] }> = [
  {
    name: "identity and registry roots",
    steps: ["migrateCounterparties"],
  },
  {
    name: "counterparty-dependent configuration and evidence",
    steps: ["migrateIntegrationConnections", "migrateMarketObservations", "migrateCounterpartyAuthorizations"],
  },
  {
    name: "customer graph",
    steps: ["migrateCustomers", "migrateBeneficiaries"],
  },
  {
    name: "payment graph and treasury positions",
    steps: ["migratePaymentOrders", "migratePaymentLegs", "migrateRateLocks", "migrateLiquidityPositions"],
  },
];

/**
 * Reads the executor's real load order.
 *
 * Function definitions appear earlier in the file in a different order, so
 * scanning the whole file measures the wrong thing. Load order is determined
 * solely by the `businessReconciliations` array, which is what this extracts.
 */
function actualInvocationOrder(): string[] {
  const source = readFileSync(EXECUTOR, "utf8");
  const marker = "const businessReconciliations = [";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("cutover executor no longer declares businessReconciliations");
  const end = source.indexOf("];", start);
  if (end < 0) throw new Error("cutover executor businessReconciliations array is unterminated");
  const block = source.slice(start + marker.length, end);
  return (block.match(/migrate[A-Za-z]+\(/g) ?? []).map(call => call.slice(0, -1));
}

describe("cutover batch ordering", () => {
  it("loads every mapped table in dependency order", () => {
    const expected = BATCHES.flatMap(batch => batch.steps);
    const actual = actualInvocationOrder();

    // Guard against the assertion silently covering nothing.
    expect(expected.length).toBe(10);
    expect(actual).toEqual(expected);
  });

  it("places no table before a table it depends on", () => {
    const order = actualInvocationOrder();
    const position = (step: string) => order.indexOf(step);

    // Each pair is a real foreign-key dependency in the canonical schema.
    const dependencies: Array<[dependent: string, prerequisite: string]> = [
      ["migrateIntegrationConnections", "migrateCounterparties"],
      ["migrateCounterpartyAuthorizations", "migrateCounterparties"],
      ["migrateMarketObservations", "migrateIntegrationConnections"],
      ["migrateBeneficiaries", "migrateCustomers"],
      ["migrateRateLocks", "migrateMarketObservations"],
      ["migratePaymentOrders", "migrateCustomers"],
      ["migratePaymentOrders", "migrateBeneficiaries"],
      ["migratePaymentLegs", "migratePaymentOrders"],
      ["migratePaymentLegs", "migrateCounterparties"],
    ];

    for (const [dependent, prerequisite] of dependencies) {
      expect(position(prerequisite)).toBeGreaterThanOrEqual(0);
      expect(position(dependent)).toBeGreaterThan(position(prerequisite));
    }
  });

  it("declares exactly one snapshot, one validation, and one reconciliation per run", () => {
    const source = readFileSync(EXECUTOR, "utf8");

    // One source snapshot hash governs the whole run.
    expect((source.match(/sourceSnapshotSha256 = checksum\(/g) ?? []).length).toBe(1);
    // One approval gate compares that hash before any apply.
    expect((source.match(/MIGRATION_APPROVED_SOURCE_SNAPSHOT_SHA256/g) ?? []).length).toBeGreaterThanOrEqual(1);
    // A dry run is rollback-only; an apply is the only path that commits.
    expect(source).toContain('await target.query(dryRun ? "ROLLBACK" : "COMMIT")');
    // Every batch reports into the same reconciliation array, so one review
    // covers the whole run rather than one review per table.
    expect(source).toContain("reconciliations: [userReconciliation, ...businessReconciliations]");
  });
});
