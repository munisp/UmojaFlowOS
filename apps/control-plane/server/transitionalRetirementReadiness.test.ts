import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Retirement readiness for the transitional MySQL/TiDB surface.
 *
 * Retiring the transitional source is blocked on an approved production
 * cutover, which this project cannot perform. What *can* be done, and what this
 * asserts, is that the surface awaiting retirement is enumerated exactly. The
 * failure this prevents is the realistic one: the cutover eventually happens,
 * someone deletes "the MySQL code", and a reference survives in a file nobody
 * remembered. This file is the checklist, and it fails if the surface grows.
 *
 * It is deliberately an exact set rather than a maximum count. A new MySQL
 * reference anywhere else must break the build and be argued for explicitly.
 */
const ROOT = process.cwd();

/**
 * The complete set of files permitted to reference the transitional driver,
 * each with the reason it is still required.
 */
const PERMITTED_MYSQL_SURFACE: Record<string, string> = {
  "server/db.ts": "Template-provided transitional client; reads only, fail-closed, retired with the cutover.",
  "drizzle/schema.ts": "Transitional schema definition, frozen by the boundary baseline digest.",
  "scripts/postgres/cutover-preflight.mjs": "Reads the source to produce the pre-cutover snapshot.",
  "scripts/postgres/migrate-transition.mjs": "The cutover executor itself.",
  "scripts/postgres/cutover-fixture-harness.mjs": "Drives the executor against the real source in regressions.",
};

/**
 * The boundary validator writes the driver name only inside escaped regular
 * expressions (`/\\bmysql2\\b/`), so the literal string never appears and it is
 * correctly absent from the sweep. Recorded here so the absence reads as
 * deliberate rather than as an oversight.
 */
const NAMES_DRIVER_ONLY_INSIDE_ESCAPED_PATTERNS = "scripts/postgres/validate-transitional-boundary.mjs";

/** Files that may read the bare transitional connection string. */
const PERMITTED_DATABASE_URL_SURFACE = new Set([
  "server/db.ts",
  "server/_core/env.ts",
  "scripts/postgres/validate-transitional-boundary.mjs",
  // Each cutover script falls back to the bare transitional URL when the
  // explicit MYSQL_SOURCE_DATABASE_URL is not set, and each retires with the
  // cutover itself.
  "scripts/postgres/cutover-preflight.mjs",
  "scripts/postgres/migrate-transition.mjs",
  "scripts/postgres/cutover-fixture-harness.mjs",
]);

/** Source trees searched for transitional references. */
const SEARCH_ROOTS = ["server", "scripts", "drizzle", "client/src", "shared"];

function walk(dir: string, out: string[] = []): string[] {
  const entries = readdirSyncSafe(dir);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function readdirSyncSafe(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    // A search root that does not exist contributes nothing rather than
    // aborting the sweep.
    return [];
  }
}

function collectMatches(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const root of SEARCH_ROOTS) {
    for (const file of walk(join(ROOT, root))) {
      // This checklist necessarily contains the strings it searches for.
      if (file.endsWith("transitionalRetirementReadiness.test.ts")) continue;
      const contents = readFileSync(file, "utf8");
      if (pattern.test(contents)) hits.push(file.slice(ROOT.length + 1));
    }
  }
  return hits.sort();
}

describe("transitional MySQL/TiDB retirement readiness", () => {
  it("confines the transitional driver to the enumerated retirement surface", () => {
    const actual = collectMatches(/\bmysql2\b|drizzle-orm\/mysql/);
    const permitted = Object.keys(PERMITTED_MYSQL_SURFACE).sort();

    // Guard against the check silently covering nothing.
    expect(permitted.length).toBe(5);
    expect(actual).toEqual(permitted);
    expect(actual).not.toContain(NAMES_DRIVER_ONLY_INSIDE_ESCAPED_PATTERNS);
  });

  it("confines the bare transitional connection string to the enumerated surface", () => {
    // Matches DATABASE_URL but not POSTGRES_DATABASE_URL, which is canonical.
    const actual = collectMatches(/(?<!POSTGRES_)\bDATABASE_URL\b/);
    expect(actual).toEqual([...PERMITTED_DATABASE_URL_SURFACE].sort());
  });

  it("keeps every canonical module free of the transitional driver", () => {
    // The canonical modules are the ones that must survive retirement
    // untouched. If any acquires a MySQL reference, retirement stops being a
    // deletion and becomes a refactor.
    const canonical = [
      "server/postgres.ts",
      "server/routers.ts",
      "server/paymentWorkflow.ts",
      "server/complianceCaseWorkflow.ts",
      "server/operationalAlerts.ts",
      "server/legalEntityRegistry.ts",
      "server/analysisSubmission.ts",
      "server/serviceBridge.ts",
      "server/contracts/services.ts",
    ];
    for (const relative of canonical) {
      const contents = readFileSync(join(ROOT, relative), "utf8");
      expect(contents).not.toMatch(/\bmysql2\b|drizzle-orm\/mysql/);
      expect(contents).not.toMatch(/(?<!POSTGRES_)\bDATABASE_URL\b/);
    }
  });

  it("documents a reason for every file awaiting retirement", () => {
    for (const [file, reason] of Object.entries(PERMITTED_MYSQL_SURFACE)) {
      expect(reason.length).toBeGreaterThan(20);
      // The file must actually exist, or the checklist is stale.
      expect(() => readFileSync(join(ROOT, file), "utf8")).not.toThrow();
    }
  });
});
