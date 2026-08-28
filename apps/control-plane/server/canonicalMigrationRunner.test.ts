import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const packageFile = resolve(repositoryRoot, "apps/control-plane/package.json");
const runner = resolve(repositoryRoot, "scripts/infra/apply_postgres_migrations.sh");

describe("canonical PostgreSQL migration runner", () => {
  it("uses the root migration chain and exposes its checksummed inventory without credentials", () => {
    const output = execFileSync("bash", [runner, "--dry-run"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {},
    });

    expect(output).toContain("database/postgresql");
    expect(output).toMatch(/\b0001_control_plane\.sql\b/);
    expect(output).toMatch(/\b0042_tigerbeetle_postgres_reconciliation\.sql\b/);
    expect(output.split("\n").filter(line => /\b00\d{2}_.*\.sql$/.test(line))).toHaveLength(48);
  });

  it("replaces the non-existent baseline command and removes the divergent application-side migration source", () => {
    const packageJson = JSON.parse(readFileSync(packageFile, "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts["postgres:migrate"]).toBe("../../scripts/infra/apply_postgres_migrations.sh");
    expect(existsSync(resolve(repositoryRoot, "database/postgresql/0001_baseline.sql"))).toBe(false);
    expect(existsSync(resolve(repositoryRoot, "apps/control-plane/database/postgresql"))).toBe(false);
  });
});
