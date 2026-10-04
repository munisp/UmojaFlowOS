import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getPool, type Actor } from "./postgres";

/**
 * Stakeholder account persistence (migrations 0018/0019/0020/0021/0025).
 *
 * These tables were previously orphaned schema: the migrations created them,
 * but no server module read or wrote them, so any stakeholder-portal account
 * data would have been silently lost. This module is the single write/read
 * path. It records governance facts only — it never grants platform roles by
 * itself (role grants stay in operatorRoleGrants) and never authenticates a
 * session without verifying the scrypt credential and approval status.
 */

export type StakeholderAccountStatus = "pending_approval" | "active" | "suspended";

const USERNAME_RE = /^[a-z][a-z0-9_.-]{2,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function scryptHash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$16384$8$1$${salt}$${derived}`;
}

export function verifyScrypt(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hex] = parts;
  const derived = scryptSync(password, salt, 64, { N: Number(n), r: Number(r), p: Number(p) });
  const expected = Buffer.from(hex, "hex");
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

async function governanceAudit(
  administratorAccountId: string,
  actorSubject: string,
  action: string,
  reason: string,
  handoverTo: string | null = null,
  metadata: Record<string, unknown> = {},
) {
  await getPool().query(
    `INSERT INTO administrator_governance_audit
       (administrator_account_id, actor_subject, action, reason, handover_to_administrator_account_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [administratorAccountId, actorSubject, action, reason, handoverTo, JSON.stringify(metadata)],
  );
}

/** Public enrolment: creates a pending_approval account. No session is issued. */
export async function requestStakeholderAccount(input: {
  username: string;
  displayName: string;
  password: string;
  requestedRole: string;
  notificationEmail?: string | null;
}) {
  if (!USERNAME_RE.test(input.username)) throw new Error("username must match ^[a-z][a-z0-9_.-]{2,63}$");
  if (input.displayName.trim().length < 2 || input.displayName.length > 120) throw new Error("display_name length 2..120");
  if (input.password.length < 12) throw new Error("password must be at least 12 characters");
  if (input.notificationEmail != null && !EMAIL_RE.test(input.notificationEmail)) throw new Error("invalid notification_email");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO stakeholder_accounts (username, display_name, password_scrypt, requested_role, notification_email)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [input.username, input.displayName.trim(), scryptHash(input.password), input.requestedRole, input.notificationEmail ?? null],
  );
  await governanceAudit(rows[0].id, input.username, "enrollment_requested", `Stakeholder account enrolment requested for role ${input.requestedRole}.`);
  return { id: rows[0].id };
}

/** Super-administrator approval decision; required before an admin account can activate (enforced by DB trigger 0021). */
export async function decideAdministratorApproval(actor: Actor, input: {
  administratorAccountId: string;
  decision: "approved" | "rejected" | "suspended" | "revoked";
  rationale: string;
}) {
  const admin = await getPool().query(
    `SELECT 1 FROM super_administrator_assignments WHERE subject=$1 AND status='active'`,
    [actor.openId],
  );
  if (admin.rowCount === 0) throw new Error("only an active super-administrator may record approval decisions");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO administrator_approval_decisions (administrator_account_id, decision, decided_by, rationale)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [input.administratorAccountId, input.decision, actor.openId, input.rationale],
  );
  await governanceAudit(
    input.administratorAccountId,
    actor.openId,
    input.decision === "approved" ? "approval_granted" : input.decision === "rejected" ? "approval_rejected" : input.decision === "suspended" ? "access_suspended" : "access_revoked",
    input.rationale,
  );
  return { id: rows[0].id };
}

/** Approve (activate) or suspend an account. Activation of admin-role accounts is gated by the DB trigger. */
export async function transitionStakeholderAccount(actor: Actor, input: {
  accountId: string;
  target: "active" | "suspended";
  reason: string;
}) {
  const { rows } = await getPool().query<{ id: string; requested_role: string }>(
    `UPDATE stakeholder_accounts
        SET status=$2,
            approved_by=CASE WHEN $2='active' THEN $3 ELSE approved_by END,
            approved_at=CASE WHEN $2='active' THEN now() ELSE approved_at END
      WHERE id=$1 RETURNING id, requested_role`,
    [input.accountId, input.target, actor.openId],
  );
  if (rows.length === 0) throw new Error("stakeholder account not found");
  await governanceAudit(
    input.accountId,
    actor.openId,
    input.target === "active" ? "approval_granted" : "access_suspended",
    input.reason,
  );
  return rows[0];
}

export async function listStakeholderAccounts(status?: StakeholderAccountStatus) {
  const { rows } = await getPool().query(
    `SELECT id, username, display_name AS "displayName", requested_role AS "requestedRole", status,
            notification_email AS "notificationEmail", approved_by AS "approvedBy", approved_at AS "approvedAt",
            created_at AS "createdAt", last_signed_in_at AS "lastSignedInAt"
       FROM stakeholder_accounts
      ${status ? "WHERE status=$1" : ""}
      ORDER BY created_at DESC LIMIT 500`,
    status ? [status] : [],
  );
  return rows;
}

/** Super-administrator assignment lifecycle. */
export async function assignSuperAdministrator(actor: Actor, subject: string) {
  await getPool().query(
    `INSERT INTO super_administrator_assignments (subject, assigned_by)
     VALUES ($1,$2)
     ON CONFLICT (subject) DO UPDATE SET status='active', assigned_by=$2, assigned_at=now(),
       revoked_by=NULL, revoked_at=NULL, revocation_reason=NULL`,
    [subject, actor.openId],
  );
  await governanceAudit(subject, actor.openId, "super_administrator_assigned", "Super-administrator assignment recorded by platform administrator.");
}

export async function revokeSuperAdministrator(actor: Actor, subject: string, reason: string) {
  const { rowCount } = await getPool().query(
    `UPDATE super_administrator_assignments
        SET status='revoked', revoked_by=$2, revoked_at=now(), revocation_reason=$3
      WHERE subject=$1 AND status='active'`,
    [subject, actor.openId, reason],
  );
  if (rowCount === 0) throw new Error("no active super-administrator assignment for subject");
  await governanceAudit(subject, actor.openId, "super_administrator_revoked", reason);
}

export async function listSuperAdministrators() {
  const { rows } = await getPool().query(
    `SELECT subject, status, assigned_by AS "assignedBy", assigned_at AS "assignedAt",
            revoked_by AS "revokedBy", revoked_at AS "revokedAt", revocation_reason AS "revocationReason"
       FROM super_administrator_assignments ORDER BY assigned_at DESC`,
  );
  return rows;
}

export async function listAdministratorGovernanceAudit(accountId?: string) {
  const { rows } = await getPool().query(
    `SELECT id, administrator_account_id AS "administratorAccountId", actor_subject AS "actorSubject",
            action, reason, metadata, occurred_at AS "occurredAt"
       FROM administrator_governance_audit
      ${accountId ? "WHERE administrator_account_id=$1" : ""}
      ORDER BY occurred_at DESC LIMIT 500`,
    accountId ? [accountId] : [],
  );
  return rows;
}

// ---------------------------------------------------------------- sessions

/** Verified sign-in: checks scrypt credential + active status, then issues an opaque session token. */
export async function signInStakeholderAccount(username: string, password: string, sessionTtlHours = 12) {
  const { rows } = await getPool().query<{
    id: string; password_scrypt: string; status: StakeholderAccountStatus;
  }>(
    `SELECT id, password_scrypt, status FROM stakeholder_accounts WHERE lower(username)=lower($1)`,
    [username],
  );
  const account = rows[0];
  if (!account || !verifyScrypt(password, account.password_scrypt)) throw new Error("invalid credentials");
  if (account.status !== "active") throw new Error(`account is ${account.status}`);
  const token = randomBytes(32).toString("hex");
  const tokenSha256 = createHash("sha256").update(token).digest("hex");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO stakeholder_account_sessions (stakeholder_account_id, token_sha256, expires_at)
       VALUES ($1,$2, now() + make_interval(hours => $3))`,
      [account.id, tokenSha256, sessionTtlHours],
    );
    await client.query(`UPDATE stakeholder_accounts SET last_signed_in_at=now() WHERE id=$1`, [account.id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { accountId: account.id, sessionToken: token, expiresInHours: sessionTtlHours };
}

export async function resolveStakeholderSession(sessionToken: string) {
  const tokenSha256 = createHash("sha256").update(sessionToken).digest("hex");
  const { rows } = await getPool().query(
    `SELECT s.id AS "sessionId", a.id AS "accountId", a.username, a.display_name AS "displayName",
            a.requested_role AS "requestedRole", a.status
       FROM stakeholder_account_sessions s
       JOIN stakeholder_accounts a ON a.id = s.stakeholder_account_id
      WHERE s.token_sha256=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND a.status='active'`,
    [tokenSha256],
  );
  return rows[0] ?? null;
}

export async function revokeStakeholderSession(actor: Actor, sessionId: string, reason: string) {
  const { rowCount } = await getPool().query(
    `UPDATE stakeholder_account_sessions SET revoked_at=now(), revoked_reason=$2
      WHERE id=$1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
  if (rowCount === 0) throw new Error("session not found or already revoked");
}

export async function listStakeholderSessions(accountId?: string) {
  const { rows } = await getPool().query(
    `SELECT id, stakeholder_account_id AS "stakeholderAccountId", issued_at AS "issuedAt",
            expires_at AS "expiresAt", revoked_at AS "revokedAt", revoked_reason AS "revokedReason"
       FROM stakeholder_account_sessions
      ${accountId ? "WHERE stakeholder_account_id=$1" : ""}
      ORDER BY issued_at DESC LIMIT 500`,
    accountId ? [accountId] : [],
  );
  return rows;
}

// ------------------------------------------------- preferences + messaging

export async function upsertNotificationPreferences(actor: Actor, accountId: string, emailKycRemindersEnabled: boolean) {
  await getPool().query(
    `INSERT INTO stakeholder_notification_preferences (stakeholder_account_id, email_kyc_reminders_enabled, updated_by)
     VALUES ($1,$2,$3)
     ON CONFLICT (stakeholder_account_id) DO UPDATE
       SET email_kyc_reminders_enabled=$2, updated_by=$3, updated_at=now()`,
    [accountId, emailKycRemindersEnabled, actor.openId],
  );
}

export async function getNotificationPreferences(accountId: string) {
  const { rows } = await getPool().query(
    `SELECT stakeholder_account_id AS "stakeholderAccountId", email_kyc_reminders_enabled AS "emailKycRemindersEnabled",
            updated_by AS "updatedBy", updated_at AS "updatedAt"
       FROM stakeholder_notification_preferences WHERE stakeholder_account_id=$1`,
    [accountId],
  );
  return rows[0] ?? null;
}

export type SecurityMessageType =
  | "account_approved" | "account_suspended" | "account_revoked"
  | "kyc_approved" | "kyc_rejected" | "kyc_action_required";

/** Records a privacy-safe security message: only a hash of the rendered content is stored. */
export async function recordSecurityMessage(accountId: string, messageType: SecurityMessageType, renderedContent: string) {
  const messageHash = createHash("sha256").update(renderedContent).digest("hex");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO stakeholder_account_security_messages (stakeholder_account_id, message_type, message_hash)
     VALUES ($1,$2,$3)
     ON CONFLICT (stakeholder_account_id, message_type, message_hash) DO NOTHING
     RETURNING id`,
    [accountId, messageType, messageHash],
  );
  return { id: rows[0]?.id ?? null, messageHash };
}

export async function markSecurityMessageDelivered(messageId: string, delivered: boolean) {
  await getPool().query(
    `UPDATE stakeholder_account_security_messages
        SET message_state=$2, delivered_at=CASE WHEN $2='delivered' THEN now() ELSE NULL END
      WHERE id=$1`,
    [messageId, delivered ? "delivered" : "failed"],
  );
}

export async function listSecurityMessages(accountId: string) {
  const { rows } = await getPool().query(
    `SELECT id, message_type AS "messageType", message_state AS "messageState", message_hash AS "messageHash",
            created_at AS "createdAt", delivered_at AS "deliveredAt"
       FROM stakeholder_account_security_messages
      WHERE stakeholder_account_id=$1 ORDER BY created_at DESC LIMIT 200`,
    [accountId],
  );
  return rows;
}

/** KYC reminder delivery ledger (0025) — privacy-safe: stores only the message hash. */
export async function recordKycReminderDelivery(input: {
  evidenceRequestId: string;
  stakeholderAccountId: string;
  channel: "in_platform" | "email";
  renderedMessage: string;
}) {
  const hash = createHash("sha256").update(input.renderedMessage).digest("hex");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO stakeholder_kyc_reminder_deliveries
       (evidence_request_id, stakeholder_account_id, channel, privacy_safe_message_hash)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (evidence_request_id, channel, privacy_safe_message_hash) DO NOTHING
     RETURNING id`,
    [input.evidenceRequestId, input.stakeholderAccountId, input.channel, hash],
  );
  return { id: rows[0]?.id ?? null, privacySafeMessageHash: hash };
}

export async function listKycReminderDeliveries(accountId?: string) {
  const { rows } = await getPool().query(
    `SELECT id, evidence_request_id AS "evidenceRequestId", stakeholder_account_id AS "stakeholderAccountId",
            channel, delivery_state AS "deliveryState", created_at AS "createdAt", delivered_at AS "deliveredAt"
       FROM stakeholder_kyc_reminder_deliveries
      ${accountId ? "WHERE stakeholder_account_id=$1" : ""}
      ORDER BY created_at DESC LIMIT 500`,
    accountId ? [accountId] : [],
  );
  return rows;
}
