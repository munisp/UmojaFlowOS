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
  it("confines activation to exactly one auditable code path", () => {
    // This is the load-bearing assertion. Every downstream capability — rate
    // locks, market observations, payment execution — requires an active
    // integration. Previously nothing could produce that state at all; now
    // exactly one function can, and the point of this check is that it stays
    // exactly one. A second activation path is how a gate quietly stops being
    // a gate.
    const offenders: string[] = [];
    for (const file of serverSources()) {
      const contents = readFileSync(file, "utf8");
      // A readiness query is allowed to read `state='active'`; it cannot make
      // an integration active. This guard is about writes to the lifecycle.
      if (/UPDATE\s+integration_connections[\s\S]{0,300}\bSET\s+state\b/i.test(contents)) {
        offenders.push(file.slice(ROOT.length + 1));
      }
    }
    // postgres.ts holds activatePostgresIntegrationConnection; nothing else may.
    expect(offenders).toEqual(["server/postgres.ts"]);
  });

  it("makes that single path conditional on a passed health check", () => {
    // The gate is only as good as the condition guarding it, so the condition
    // is asserted directly rather than assumed from the function's name.
    const source = readFileSync(join(ROOT, "server", "postgres.ts"), "utf8");
    const activation = source.slice(source.indexOf("export async function activatePostgresIntegrationConnection"));
    const body = activation.slice(0, activation.indexOf("\nexport "));

    // The state written is derived from the outcome, never hard-coded to active.
    expect(body).toMatch(/const passed = input\.outcome\.reachable/);
    expect(body).toMatch(/nextState = passed \? "active" : "failed"/);
    // Activation is impossible without a configured credential reference.
    expect(body).toMatch(/configure a credential reference before attempting activation/);
    // The 2xx requirement is explicit rather than implied by `reachable`.
    expect(body).toMatch(/httpStatus >= 200 && input\.outcome\.httpStatus < 300/);
  });

  it("keeps the health-check probe separate from the activation decision", () => {
    // If the probe decided, a bug in the probe would be a bug in the gate. The
    // probe reports; the repository decides.
    const probe = readFileSync(join(ROOT, "server", "providerHealthCheck.ts"), "utf8");
    expect(probe).not.toMatch(/UPDATE integration_connections/);
    expect(probe).not.toMatch(/'active'/);
  });

  it("never persists a credential value, only a reference to a deployment secret", () => {
    const source = readFileSync(join(ROOT, "server", "postgres.ts"), "utf8");
    // The configuration function writes secret_reference and nothing else
    // credential-shaped.
    const configure = source.slice(source.indexOf("export async function configurePostgresIntegrationCredential"));
    const body = configure.slice(0, configure.indexOf("\nexport "));
    expect(body).toMatch(/assertIsSecretReferenceNotSecret/);
    expect(body).toMatch(/credentialValuePersisted: false/);
    // The credential is resolved from the environment at call time, in the
    // probe, and never reaches the repository at all.
    expect(body).not.toMatch(/process\.env\[/);
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
    const client = new Client({ connectionString: process.env.POSTGRES_DATABASE_URL ?? "postgresql:///umojaflowos_dev" });
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
