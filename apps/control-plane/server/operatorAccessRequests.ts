import { getPool, type Actor } from "./postgres";

export async function recordOperatorAccessAttempt(subject: string, name: string | null, email: string | null) {
  await getPool().query(
    `INSERT INTO operator_access_requests (subject, name, email)
     VALUES ($1,$2,$3)
     ON CONFLICT (subject) DO UPDATE
     SET name=EXCLUDED.name, email=EXCLUDED.email, last_seen_at=now()
     WHERE operator_access_requests.resolved_at IS NULL`,
    [subject, name, email],
  );
}

export async function listOperatorAccessRequests() {
  const { rows } = await getPool().query(
    `SELECT subject, name, email, first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt"
       FROM operator_access_requests
      WHERE resolved_at IS NULL
      ORDER BY last_seen_at DESC`,
  );
  return rows;
}

export async function resolveOperatorAccessRequest(actor: Actor, subject: string) {
  await getPool().query(
    `UPDATE operator_access_requests SET resolved_at = now(), resolved_by = $2
      WHERE subject = $1 AND resolved_at IS NULL`,
    [subject, actor.openId],
  );
}
