import { afterAll, describe, expect, it } from "vitest";
import { closePostgresPool, getPostgresCutoverReadiness, getPostgresReadiness, listPostgresCounterparties, listPostgresCounterpartyAuthorizations } from "./postgres";

const runIntegration = process.env.POSTGRES_INTEGRATION_TEST === "1";

describe.skipIf(!runIntegration)("local PostgreSQL canonical schema", () => {
  afterAll(async () => {
    await closePostgresPool();
  });

  it("connects through the local peer-authenticated role and exposes the canonical table set", async () => {
    const readiness = await getPostgresReadiness();
    expect(readiness.connected).toBe(true);
    expect(readiness.database).toBe("umojaflowos_dev");
    expect(readiness.tableCount).toBe(23);
    expect(readiness.version).toContain("PostgreSQL");
  });

  it("reports local canonical-schema cutover readiness without representing production deployment as complete", async () => {
    const readiness = await getPostgresCutoverReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.missingTables).toEqual([]);
    expect(readiness.activationBoundary).toContain("production cutover still requires");
  });

  it("reads the canonical counterparty and licence-authorisation ledgers without creating operational records", async () => {
    const [counterparties, authorizations] = await Promise.all([
      listPostgresCounterparties(),
      listPostgresCounterpartyAuthorizations(),
    ]);

    expect(Array.isArray(counterparties)).toBe(true);
    expect(Array.isArray(authorizations)).toBe(true);
    expect(authorizations.every(record => counterparties.some(counterparty => counterparty.id === record.counterpartyId))).toBe(true);
  });
});
