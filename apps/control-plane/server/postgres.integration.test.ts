import { afterAll, describe, expect, it } from "vitest";
import { closePostgresPool, getPostgresReadiness } from "./postgres";

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
});
