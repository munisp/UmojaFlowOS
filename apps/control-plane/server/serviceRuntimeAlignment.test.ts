/**
 * Code-backed evidence that every non-TypeScript service is PostgreSQL-first.
 *
 * `docs/service-contracts.md` asserts that the Go, Rust, and Python services
 * hold no authoritative store of their own and compute only over inputs the
 * control plane supplies. That is a claim about dependencies and imports, so it
 * can be checked mechanically instead of trusted: a service that acquired a
 * database client would gain a second system of record, and no schema check at
 * the boundary would ever notice.
 *
 * These tests read the real manifests and sources in the canonical monorepo. If
 * the monorepo is not present (for example in the managed project alone) they
 * skip rather than pass vacuously.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SERVICES_DIR = resolve(process.cwd(), "../UmojaFlowOS/services");
const describeAligned = existsSync(SERVICES_DIR) ? describe : describe.skip;

/** Client libraries that would give a service its own authoritative store. */
const DATABASE_CLIENT_MARKERS = [
  // PostgreSQL
  "sqlx",
  "tokio-postgres",
  "diesel",
  "psycopg",
  "asyncpg",
  "sqlalchemy",
  "lib/pq",
  "jackc/pgx",
  "database/sql",
  // MySQL / TiDB, which are transitional only and must never be reachable here
  "mysql",
  "pymysql",
  "go-sql-driver",
  // Other stores that would constitute a second system of record
  "mongodb",
  "redis",
  "cassandra",
];

function readFilesRecursively(directory: string, extensions: string[]): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(directory)) {
    // Build outputs and virtualenvs contain vendored dependencies that are not
    // the services' own source, so they are excluded deliberately.
    if (["target", "node_modules", ".venv", "__pycache__", "dist"].includes(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      collected.push(...readFilesRecursively(full, extensions));
    } else if (extensions.some(extension => entry.endsWith(extension))) {
      collected.push(full);
    }
  }
  return collected;
}

describeAligned("service runtime alignment with the canonical PostgreSQL store", () => {
  it("declares no database client in any service manifest", () => {
    const manifests = [
      "payment-engine/go.mod",
      "risk-compliance-core/Cargo.toml",
      "ledger-gateway/Cargo.toml",
      "reporting-analytics/pyproject.toml",
    ]
      .map(relative => join(SERVICES_DIR, relative))
      .filter(path => existsSync(path));

    // Guard against the test silently covering nothing.
    expect(manifests.length).toBe(4);

    for (const manifest of manifests) {
      const contents = readFileSync(manifest, "utf8").toLowerCase();
      for (const marker of DATABASE_CLIENT_MARKERS) {
        expect(contents, `${manifest} declares ${marker}`).not.toContain(marker);
      }
    }
  });

  it("imports no database client in any service source file", () => {
    const sources = [
      ...readFilesRecursively(join(SERVICES_DIR, "payment-engine"), [".go"]),
      ...readFilesRecursively(join(SERVICES_DIR, "risk-compliance-core"), [".rs"]),
      ...readFilesRecursively(join(SERVICES_DIR, "ledger-gateway"), [".rs"]),
      ...readFilesRecursively(join(SERVICES_DIR, "reporting-analytics"), [".py"]),
    ];

    expect(sources.length).toBeGreaterThan(10);

    for (const source of sources) {
      const contents = readFileSync(source, "utf8");
      // Only import and use statements are inspected: prose in a comment that
      // mentions PostgreSQL as the system of record is correct and expected.
      const importLines = contents
        .split("\n")
        .filter(line => /^\s*(import|use|from|require)\b/.test(line))
        .join("\n")
        .toLowerCase();
      for (const marker of DATABASE_CLIENT_MARKERS) {
        expect(importLines, `${source} imports ${marker}`).not.toContain(marker);
      }
    }
  });

  it("keeps the ledger gateway a verifier that cannot post to TigerBeetle", () => {
    const gateway = join(SERVICES_DIR, "ledger-gateway/src");
    const sources = readFilesRecursively(gateway, [".rs"]);
    const combined = sources.map(path => readFileSync(path, "utf8")).join("\n");

    // No TigerBeetle client may be linked: writing to the ledger is gated behind
    // the cluster configuration under infra/, not reachable from this service.
    expect(combined.toLowerCase()).not.toContain("tigerbeetle_client");
    expect(combined.toLowerCase()).not.toContain("tb_client");

    // And the service must state the backend is not deployed rather than imply one.
    expect(combined).toContain("disabled_without_deployed_tigerbeetle");
  });

  it("keeps every service listener free of embedded credentials", () => {
    const sources = [
      ...readFilesRecursively(join(SERVICES_DIR, "payment-engine"), [".go"]),
      ...readFilesRecursively(join(SERVICES_DIR, "risk-compliance-core"), [".rs"]),
      ...readFilesRecursively(join(SERVICES_DIR, "ledger-gateway"), [".rs"]),
      ...readFilesRecursively(join(SERVICES_DIR, "reporting-analytics"), [".py"]),
    ];

    for (const source of sources) {
      const contents = readFileSync(source, "utf8");
      // A connection string with an inline password is the classic way a second
      // store and a leaked credential enter a codebase at once.
      expect(contents, `${source} contains a credentialed connection string`).not.toMatch(
        /(postgres|postgresql|mysql):\/\/[^\s"']*:[^\s"'@]+@/i,
      );
    }
  });
});
