import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";

import { closePostgresPool, getPool } from "./postgres";
import { drainLakehouseControlEvidence } from "./lakehouseControlEvidence";
import { postgresTestSchemaOwnerPsqlArguments } from "./testPostgres";

const run = process.env.POSTGRES_INTEGRATION_TEST === "1" ? describe : describe.skip;
const fixtureCorrelation = "a".repeat(64);

function purge() {
  execFileSync("psql", ["-v", "ON_ERROR_STOP=1", "-q", ...postgresTestSchemaOwnerPsqlArguments(), "-c", `DELETE FROM control_evidence_outbox WHERE correlation_sha256='${fixtureCorrelation}'`], { stdio: "ignore" });
}

async function listener(handler: (body: unknown, headers: Record<string, string | string[] | undefined>) => { status?: number; response?: unknown }) {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      const result = handler(JSON.parse(raw || "{}"), request.headers);
      response.writeHead(result.status ?? 200, { "content-type": "application/json" });
      response.end(JSON.stringify(result.response ?? { authoritative: false }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  return { server, endpoint: `http://127.0.0.1:${address.port}` };
}

async function seed() {
  await getPool().query(
    `INSERT INTO control_evidence_outbox (source, event_type, correlation_sha256, observed_at, outcome, payload)
     VALUES ('postgresql_control','umojaflowos.counterparty.onboarding.created.v1',$1,now(),'created','{"authoritative":false,"stage":"legal_onboarding"}')`,
    [fixtureCorrelation],
  );
  return fixtureCorrelation;
}

run("canonical PostgreSQL control-evidence outbox", () => {
  let server: Server | undefined;

  beforeEach(() => {
    purge();
    delete process.env.UMOJA_LAKEHOUSE_CATALOG_URL;
    delete process.env.UMOJA_LAKEHOUSE_POSTGRESQL_CONTROL_TOKEN;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
    server = undefined;
  });

  afterAll(async () => {
    purge();
    await closePostgresPool();
  });

  it("does no network work while lakehouse delivery is not configured", async () => {
    const correlation = await seed();
    await expect(drainLakehouseControlEvidence(25, correlation)).resolves.toEqual({ status: "not_configured", delivered: 0, pending: 0, failed: 0 });
    const row = await getPool().query("SELECT delivery_state, delivery_attempts FROM control_evidence_outbox WHERE correlation_sha256=$1", [correlation]);
    expect(row.rows).toEqual([{ delivery_state: "pending", delivery_attempts: 0 }]);
  });

  it("delivers only the redacted source-bound catalog record and then cannot redeliver it", async () => {
    const correlation = await seed();
    const received: unknown[] = [];
    const running = await listener((body, headers) => {
      received.push({ body, authorization: headers.authorization });
      return {};
    });
    server = running.server;
    process.env.UMOJA_LAKEHOUSE_CATALOG_URL = running.endpoint;
    process.env.UMOJA_LAKEHOUSE_POSTGRESQL_CONTROL_TOKEN = "test-control-token";

    await expect(drainLakehouseControlEvidence(25, correlation)).resolves.toMatchObject({ status: "completed", delivered: 1, failed: 0 });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      authorization: "Bearer test-control-token",
      body: {
        source: "postgresql_control",
        event_type: "umojaflowos.counterparty.onboarding.created.v1",
        correlation_sha256: correlation,
        outcome: "created",
        observed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    });
    await expect(drainLakehouseControlEvidence(25, correlation)).resolves.toMatchObject({ delivered: 0, pending: 0, failed: 0 });
    const row = await getPool().query("SELECT delivery_state, delivery_attempts, last_delivery_error FROM control_evidence_outbox WHERE correlation_sha256=$1", [correlation]);
    expect(row.rows).toEqual([{ delivery_state: "delivered", delivery_attempts: 1, last_delivery_error: null }]);
  });

  it("records a bounded delivery failure and keeps the canonical event pending for retry", async () => {
    const correlation = await seed();
    const running = await listener(() => ({ status: 503, response: { error: "unavailable" } }));
    server = running.server;
    process.env.UMOJA_LAKEHOUSE_CATALOG_URL = running.endpoint;
    process.env.UMOJA_LAKEHOUSE_POSTGRESQL_CONTROL_TOKEN = "test-control-token";

    await expect(drainLakehouseControlEvidence(25, correlation)).resolves.toMatchObject({ status: "completed", delivered: 0, failed: 1 });
    const row = await getPool().query("SELECT delivery_state, delivery_attempts, last_delivery_error FROM control_evidence_outbox WHERE correlation_sha256=$1", [correlation]);
    expect(row.rows[0].delivery_state).toBe("pending");
    expect(row.rows[0].delivery_attempts).toBe(1);
    expect(row.rows[0].last_delivery_error).toContain("503");
  });
});
