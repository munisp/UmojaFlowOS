import type { User } from "../drizzle/schema";
import { getPool } from "./postgres";
import type { OperatingRole } from "./operatingRoles";

export type PlatformUser = Omit<User, "role"> & { role: OperatingRole };

/**
 * The transitional identity provider may establish a session but is not allowed
 * to create either external stakeholder authority. `provider_contact` and
 * `cbn_liaison` are resolvable only from canonical PostgreSQL assignments.
 */
export async function resolvePostgresOperatingRole(user: User): Promise<PlatformUser> {
  const { rows } = await getPool().query<{ role: OperatingRole }>(
    `SELECT role::text AS role, 1 AS precedence
       FROM operator_role_assignments
      WHERE subject=$1 AND status='assigned'
     UNION ALL
     SELECT role::text AS role, 2 AS precedence
       FROM user_role_assignments
      WHERE user_subject=$1 AND revoked_at IS NULL
      ORDER BY precedence, role
      LIMIT 1`,
    [user.openId],
  );
  const assigned = rows[0]?.role;
  if (assigned) return { ...user, role: assigned };
  return user;
}
