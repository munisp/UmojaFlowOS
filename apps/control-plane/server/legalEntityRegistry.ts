import { Pool } from "pg";

let pool: Pool | undefined;
function getPool() {
  if (!pool) {
    pool = process.env.POSTGRES_DATABASE_URL
      ? new Pool({ connectionString: process.env.POSTGRES_DATABASE_URL })
      : new Pool({
          host: "/var/run/postgresql",
          database: process.env.POSTGRES_TEST_DATABASE ?? "umoja_test",
          user: process.env.POSTGRES_LOCAL_USER ?? "ubuntu",
        });
  }
  return pool;
}

export type RegistryActor = {
  openId: string;
  role: "admin" | "compliance_officer" | "treasury_operator" | "auditor";
};

/**
 * The reporting legal entity is the licensed entity a CBN, CBK, or SARB return
 * is filed under. It is registered explicitly by an administrator rather than
 * inferred, because filing under the wrong entity is a regulatory breach.
 *
 * The jurisdiction is constrained by the schema to Nigeria, Kenya, or South
 * Africa, and the (jurisdiction, registration identifier) pair is unique, so the
 * same registered entity cannot be recorded twice under one jurisdiction.
 */
export async function registerPostgresLegalEntity(
  actor: RegistryActor,
  input: { legalName: string; jurisdiction: "Nigeria" | "Kenya" | "South Africa"; registrationIdentifier: string },
) {
  if (actor.role !== "admin") throw new Error("Only an administrator may register a reporting legal entity");
  const legalName = input.legalName.trim();
  const registrationIdentifier = input.registrationIdentifier.trim();
  if (legalName.length < 3) throw new Error("Registered legal name is required");
  // A registration identifier is issued by the jurisdiction's registrar, so an
  // empty or placeholder value would mean the entity is not verifiable.
  if (registrationIdentifier.length < 3) throw new Error("Registrar-issued registration identifier is required");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string }>(
      "SELECT id FROM legal_entities WHERE jurisdiction=$1 AND registration_identifier=$2",
      [input.jurisdiction, registrationIdentifier],
    );
    if (existing.rows[0]) throw new Error("This registration identifier is already recorded for the jurisdiction");

    const { rows } = await client.query<{ id: string }>(
      "INSERT INTO legal_entities (legal_name, jurisdiction, registration_identifier) VALUES ($1,$2,$3) RETURNING id",
      [legalName, input.jurisdiction, registrationIdentifier],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error("Legal-entity insert did not return a record");

    await client.query(
      "INSERT INTO activity_events (actor_subject,actor_role,action,object_type,object_id,metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
      [
        actor.openId,
        actor.role,
        "legal_entity.registered",
        "legal_entity",
        id,
        JSON.stringify({ jurisdiction: input.jurisdiction, registrationIdentifier }),
      ],
    );
    await client.query("COMMIT");
    return { id, legalName, jurisdiction: input.jurisdiction };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
