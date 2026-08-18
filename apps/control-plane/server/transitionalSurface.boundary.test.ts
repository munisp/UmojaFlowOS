import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const home = readFileSync(resolve(process.cwd(), "client/src/pages/Home.tsx"), "utf8");

/**
 * The transitional MySQL/TiDB surface is read and cutover-only. Any managed
 * console mutation must target a canonical PostgreSQL procedure, so this guard
 * fails if a transitional mutation binding reappears in the operator console.
 */
const transitionalMutationBindings = [
  "trpc.umoja.registry.create.useMutation",
  "trpc.umoja.registry.createAuthorization.useMutation",
  "trpc.umoja.registry.transitionAuthorization.useMutation",
  "trpc.umoja.registry.transitionPostgresAuthorization.useMutation",
  "trpc.umoja.alerts.evaluateDeadlines.useMutation",
  "trpc.umoja.integrations.create.useMutation",
  "trpc.umoja.policies.create.useMutation",
  "trpc.umoja.parties.createCustomer.useMutation",
  "trpc.umoja.parties.createBeneficiary.useMutation",
  "trpc.umoja.treasury.recordLiquidity.useMutation",
  "trpc.umoja.markets.record.useMutation",
  "trpc.umoja.markets.createRateLock.useMutation",
  "trpc.umoja.markets.cancelRateLock.useMutation",
  "trpc.umoja.compliance.create.useMutation",
  "trpc.umoja.reporting.create.useMutation",
  "trpc.umoja.reporting.createDeadline.useMutation",
  "trpc.umoja.alerts.create.useMutation",
];

describe("transitional MySQL/TiDB surface boundary", () => {
  it("binds no managed console mutation to a transitional procedure", () => {
    const reappeared = transitionalMutationBindings.filter(binding => home.includes(binding));
    expect(reappeared).toEqual([]);
  });

  it("keeps every canonical write path the console uses on the PostgreSQL namespace", () => {
    const canonicalMutations = home.match(/trpc\.postgres\.\w+\.useMutation/g) ?? [];
    expect(canonicalMutations.length).toBeGreaterThan(0);
    for (const mutation of canonicalMutations) {
      expect(mutation.startsWith("trpc.postgres.")).toBe(true);
    }
  });

  it("leaves the transitional namespace read-only in the operator console", () => {
    expect(home).not.toMatch(/trpc\.umoja\.[A-Za-z0-9_.]+\.useMutation/);
    const transitionalReads = home.match(/trpc\.umoja\.[A-Za-z0-9_.]+\.useQuery/g) ?? [];
    for (const read of transitionalReads) {
      expect(read.endsWith(".useQuery")).toBe(true);
    }
  });
});
