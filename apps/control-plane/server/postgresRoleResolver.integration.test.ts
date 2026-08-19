import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { User } from "../drizzle/schema";
import { getPool } from "./postgres";
import { resolvePostgresOperatingRole } from "./postgresRoleResolver";

const enabled = process.env.POSTGRES_INTEGRATION === "1";

function transitionalIdentity(subject: string): User {
  return {
    id: 1,
    openId: subject,
    name: "Role resolution regression",
    email: null,
    loginMethod: "test",
    role: "auditor",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
}

describe.runIf(enabled)("PostgreSQL external stakeholder role resolution", () => {
  it("overrides a frozen transitional identity role only from a canonical active assignment", async () => {
    const subject = `postgres-role-resolver-${randomUUID()}`;
    await getPool().query(
      "INSERT INTO operator_role_assignments (subject,role,status,assigned_by) VALUES ($1,'provider_contact','assigned','role-regression-admin')",
      [subject],
    );
    const resolved = await resolvePostgresOperatingRole(transitionalIdentity(subject));
    expect(resolved.role).toBe("provider_contact");
    expect(resolved.openId).toBe(subject);
  });

  it("does not invent an external role when canonical PostgreSQL has no assignment", async () => {
    const resolved = await resolvePostgresOperatingRole(transitionalIdentity(`postgres-role-resolver-${randomUUID()}`));
    expect(resolved.role).toBe("auditor");
  });
});
