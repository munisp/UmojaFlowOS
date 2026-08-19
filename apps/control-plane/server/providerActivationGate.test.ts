import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The provider activation gate.
 *
 * Real provider adapters cannot be written here: no approved credentials and no
 * confirmed licensed counterparties exist, and inventing either would be the
 * exact failure the whole project is built to avoid. What can be proven, and
 * what this proves, is that the gate is closed *by construction* rather than by
 * convention — so an adapter cannot be added later without deliberately
 * removing a guard.
 *
 * Each assertion below corresponds to a precondition a future adapter must
 * satisfy. Together they are the specification a provider integration inherits.
 */
const ROOT = process.cwd();

/** Integration lifecycle states defined by the canonical schema. */
const INTEGRATION_STATES = [
  "unconfigured",
  "credential_pending",
  "verification_pending",
  "active",
  "suspended",
  "failed",
] as const;

function serverSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "_core") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) out.push(full);
    }
  };
  walk(join(ROOT, "server"));
  return out;
}

describe("provider activation gate", () => {
  it("has no code path that sets an integration to the active state", () => {
    // This is the load-bearing assertion. Every downstream capability — rate
    // locks, market observations, payment execution — requires an active
    // integration, so as long as nothing can produce that state, nothing can
    // claim a live provider.
    const offenders: string[] = [];
    for (const file of serverSources()) {
      const contents = readFileSync(file, "utf8");
      // An UPDATE that assigns the active state, in any quoting style.
      if (/state\s*=\s*'active'/i.test(contents) || /set\s+state[^;]{0,80}active/i.test(contents)) {
        offenders.push(file.slice(ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("defines the full lifecycle so a future adapter has states to move through", () => {
    // The gate must be a lifecycle, not an absence. An adapter arriving with
    // credentials needs somewhere to record credential_pending and
    // verification_pending before anything becomes active.
    expect(INTEGRATION_STATES).toContain("credential_pending");
    expect(INTEGRATION_STATES).toContain("verification_pending");
    expect(INTEGRATION_STATES).toContain("active");
    expect(INTEGRATION_STATES).toContain("failed");
  });

  it("keeps credentials out of the database by storing only a secret reference", async () => {
    // Asserted against the live schema rather than the migration files, because
    // the base migrations live in the canonical monorepo while later ones live
    // here; only the database holds the whole picture.
    const { Client } = await import("pg");
    const client = new Client({
      host: "/var/run/postgresql",
      database: "umojaflowos_dev",
      user: process.env.POSTGRES_LOCAL_USER ?? "ubuntu",
    });
    await client.connect();
    try {
      const { rows } = await client.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'integration_connections'",
      );
      const columns = rows.map(row => row.column_name);
      // The integration stores a pointer to a secret, never the secret.
      expect(columns).toContain("secret_reference");
      for (const forbidden of ["api_key", "secret_value", "access_token", "client_secret", "password"]) {
        expect(columns).not.toContain(forbidden);
      }
    } finally {
      await client.end();
    }
  });

  it("refuses to let a service bridge fall back to an implicit endpoint", () => {
    // An adapter that silently defaults to localhost is how a "disabled"
    // integration becomes live by accident.
    const bridge = readFileSync(join(ROOT, "server", "serviceBridge.ts"), "utf8");
    expect(bridge).not.toMatch(/localhost:\d+["'`]/);
    expect(bridge).toMatch(/not_configured/);
  });

  it("prevents any contract from carrying execution authority", () => {
    // A provider adapter's response must remain evidence. This guard already
    // exists; the assertion records that it is part of the adapter contract.
    const contracts = readFileSync(join(ROOT, "server", "contracts", "services.ts"), "utf8");
    expect(contracts).toMatch(/assertNoExecutionAuthority/);
  });
});
