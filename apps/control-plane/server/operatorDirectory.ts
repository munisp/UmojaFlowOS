import { getPool, type Actor } from "./postgres";
import { legacyOperatingRoles, type OperatingRole } from "./operatingRoles";
import { listKeycloakAccounts, setKeycloakAccountEnabled } from "./keycloakAdmin";

type LegacyOperatingRole = "admin" | "compliance_officer" | "treasury_operator" | "auditor";

export type OperatorDirectoryEntry = {
  keycloakUserId: string;
  subject: string;
  name: string;
  email: string;
  enabled: boolean;
  role: OperatingRole | null;
  roleStatus: "assigned" | "suspended" | null;
  assignedBy: string | null;
  assignedAt: Date | null;
};

// object_id is a UUID column: it must be a real row id (or, for the account
// as a whole, the Keycloak-issued user id, which is itself a UUID) — never
// the app's internal `subject`, which is a `kc_<hash>` string and fails the
// column's type check outright.
async function recordActivity(client: { query: (text: string, values?: unknown[]) => Promise<unknown> }, actor: Actor, action: string, objectType: string, objectId: string, metadata: Record<string, unknown>) {
  await client.query(
    "INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)",
    [actor.openId, actor.role, action, objectType, objectId, JSON.stringify(metadata)],
  );
}

/**
 * Every Keycloak account in the realm, cross-referenced against its current
 * role (if any). Enumeration starts from Keycloak because the app's internal
 * subject is a one-way hash of the Keycloak user id; there is no reverse
 * lookup from Postgres alone. A roleless account here is the same cohort
 * `operatorAccessRequests` surfaces on first sign-in — this view just shows
 * everyone, not only those who have already tried to sign in.
 */
export async function listOperators(): Promise<OperatorDirectoryEntry[]> {
  const accounts = await listKeycloakAccounts();
  const [coreRoles, externalRoles] = await Promise.all([
    getPool().query<{ subject: string; role: LegacyOperatingRole; assignedBy: string; assignedAt: Date }>(
      `SELECT user_subject AS subject, role::text AS role, assigned_by AS "assignedBy", assigned_at AS "assignedAt"
         FROM user_role_assignments WHERE revoked_at IS NULL ORDER BY assigned_at DESC`,
    ),
    getPool().query<{ subject: string; role: "provider_contact" | "cbn_liaison"; status: "assigned" | "suspended"; assignedBy: string; assignedAt: Date }>(
      `SELECT subject, role::text AS role, status::text AS status, assigned_by AS "assignedBy", assigned_at AS "assignedAt"
         FROM operator_role_assignments`,
    ),
  ]);
  const roleBySubject = new Map<string, { role: OperatingRole; status: "assigned" | "suspended"; assignedBy: string; assignedAt: Date }>();
  for (const row of coreRoles.rows) roleBySubject.set(row.subject, { role: row.role, status: "assigned", assignedBy: row.assignedBy, assignedAt: row.assignedAt });
  for (const row of externalRoles.rows) roleBySubject.set(row.subject, { role: row.role, status: row.status, assignedBy: row.assignedBy, assignedAt: row.assignedAt });

  return accounts.map(account => {
    const assignment = roleBySubject.get(account.subject);
    return {
      keycloakUserId: account.keycloakUserId,
      subject: account.subject,
      name: account.name,
      email: account.email,
      enabled: account.enabled,
      role: assignment?.role ?? null,
      roleStatus: assignment?.status ?? null,
      assignedBy: assignment?.assignedBy ?? null,
      assignedAt: assignment?.assignedAt ?? null,
    };
  });
}

/**
 * Moves a subject to a different core role. Scoped to the four core roles
 * only (admin/compliance_officer/treasury_operator/auditor) — the external
 * roles (provider_contact/cbn_liaison) are tied to a specific counterparty
 * or CBN dossier and reassigning those needs that scope, not just a role
 * name, so this path deliberately doesn't touch them.
 */
export async function changeOperatorRole(actor: Actor, input: { subject: string; role: LegacyOperatingRole }) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const active = await client.query<{ id: string; role: string }>(
      "SELECT id, role::text AS role FROM user_role_assignments WHERE user_subject=$1 AND revoked_at IS NULL FOR UPDATE",
      [input.subject],
    );
    let newAssignmentId = active.rows.find(row => row.role === input.role)?.id;
    for (const row of active.rows) {
      if (row.role !== input.role) await client.query("UPDATE user_role_assignments SET revoked_at=now() WHERE id=$1", [row.id]);
    }
    if (!newAssignmentId) {
      const inserted = await client.query<{ id: string }>(
        "INSERT INTO user_role_assignments (user_subject, role, assigned_by) VALUES ($1,$2,$3) RETURNING id",
        [input.subject, input.role, actor.openId],
      );
      newAssignmentId = inserted.rows[0]?.id;
    }
    if (!newAssignmentId) throw new Error("role assignment did not return a record");
    await recordActivity(client, actor, "operator_role.changed", "user_role_assignment", newAssignmentId, { subject: input.subject, from: active.rows.map(row => row.role), to: input.role });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { subject: input.subject, role: input.role };
}

/**
 * Cuts off an operator's access without deleting anything: revokes every
 * active role grant (core and external) and disables the Keycloak account.
 * Matches the append-only convention used everywhere else in this schema —
 * there is no DELETE path for an operator, only a revoked/disabled state
 * that the audit trail retains.
 */
export async function deactivateOperator(actor: Actor, input: { keycloakUserId: string; subject: string; reason: string }) {
  if (input.subject === actor.openId) throw new Error("an operator cannot deactivate their own account");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const core = await client.query<{ id: string }>(
      "SELECT id FROM user_role_assignments WHERE user_subject=$1 AND revoked_at IS NULL FOR UPDATE",
      [input.subject],
    );
    for (const row of core.rows) await client.query("UPDATE user_role_assignments SET revoked_at=now() WHERE id=$1", [row.id]);
    await client.query(
      "UPDATE operator_role_assignments SET status='suspended', suspended_at=now() WHERE subject=$1 AND status='assigned'",
      [input.subject],
    );
    await recordActivity(client, actor, "operator.deactivated", "keycloak_account", input.keycloakUserId, { subject: input.subject, reason: input.reason, revokedCoreGrants: core.rows.length });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  await setKeycloakAccountEnabled(input.keycloakUserId, false);
  return { subject: input.subject };
}
