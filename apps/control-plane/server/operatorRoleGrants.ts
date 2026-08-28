import type { PoolClient } from "pg";
import { getPool, type Actor } from "./postgres";
import { legacyOperatingRoles, type OperatingRole } from "./operatingRoles";
import { resolveOperatorAccessRequest } from "./operatorAccessRequests";

async function activity(client: PoolClient, actor: Actor, action: string, objectId: string, metadata: Record<string, unknown>) {
  await client.query(
    "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,'user_role_assignment',$4,$5::jsonb)",
    [actor.openId, actor.role, action, objectId, JSON.stringify(metadata)],
  );
}

export async function grantOperatingRole(actor: Actor, input: { subject: string; role: OperatingRole }) {
  if (!legacyOperatingRoles.has(input.role)) throw new Error("this grant path is for admin, compliance_officer, treasury_operator, or auditor only; external stakeholder roles are assigned through assignExternalStakeholder");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM user_role_assignments WHERE user_subject=$1 AND role=$2 AND revoked_at IS NULL FOR UPDATE`,
      [input.subject, input.role],
    );
    const record = existing.rows[0]
      ?? (await client.query<{ id: string }>(
        `INSERT INTO user_role_assignments (user_subject, role, assigned_by) VALUES ($1,$2,$3) RETURNING id`,
        [input.subject, input.role, actor.openId],
      )).rows[0];
    if (!record) throw new Error("role grant did not return a record");
    await activity(client, actor, "operator_role.granted", record.id, { subject: input.subject, role: input.role });
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }

  await resolveOperatorAccessRequest(actor, input.subject);
  return { subject: input.subject, role: input.role };
}
