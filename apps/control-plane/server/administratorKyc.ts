import { getPool, type Actor } from "./postgres";

/**
 * Administrator KYC persistence (migrations 0022/0023/0024/0027).
 *
 * Previously orphaned schema — no module read or wrote these tables, so the
 * administrator-vetting workflow defined by the migrations could not persist
 * anything. All records are evidence pointers (URI + sha256); no document
 * content is stored here. The DB trigger enforces independent second review
 * for escalations; this module additionally enforces the upload-size policy
 * before creating upload intents.
 */

export const ADMIN_KYC_EVIDENCE_KINDS = [
  "identity_document",
  "national_identity_reference",
  "liveness_deepfake_assessment",
  "sanctions_pep_review",
] as const;
export type AdminKycEvidenceKind = (typeof ADMIN_KYC_EVIDENCE_KINDS)[number];

export const ADMIN_KYC_JURISDICTIONS = ["NG", "KE", "ZA", "OTHER"] as const;
export type AdminKycJurisdiction = (typeof ADMIN_KYC_JURISDICTIONS)[number];

const SHA256_RE = /^[0-9a-f]{64}$/;
const MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;

// ------------------------------------------------------------- upload policy

export async function getAdministratorKycUploadPolicy() {
  const { rows } = await getPool().query(
    `SELECT max_file_bytes AS "maxFileBytes", updated_by AS "updatedBy", updated_at AS "updatedAt", update_reason AS "updateReason"
       FROM administrator_kyc_upload_policy WHERE id = TRUE`,
  );
  return rows[0] ?? null;
}

export async function updateAdministratorKycUploadPolicy(actor: Actor, maxFileBytes: number, reason: string) {
  if (maxFileBytes < 1048576 || maxFileBytes > 52428800) throw new Error("max_file_bytes must be between 1 MiB and 50 MiB");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const prior = await client.query<{ max_file_bytes: number }>(
      `SELECT max_file_bytes FROM administrator_kyc_upload_policy WHERE id = TRUE FOR UPDATE`,
    );
    if (prior.rowCount === 0) throw new Error("upload policy row missing — migration 0023 seed not applied");
    await client.query(
      `UPDATE administrator_kyc_upload_policy SET max_file_bytes=$1, updated_by=$2, updated_at=now(), update_reason=$3 WHERE id = TRUE`,
      [maxFileBytes, actor.openId, reason],
    );
    await client.query(
      `INSERT INTO administrator_kyc_upload_policy_audit (prior_max_file_bytes, new_max_file_bytes, changed_by, reason)
       VALUES ($1,$2,$3,$4)`,
      [prior.rows[0].max_file_bytes, maxFileBytes, actor.openId, reason],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listAdministratorKycUploadPolicyAudit() {
  const { rows } = await getPool().query(
    `SELECT id, prior_max_file_bytes AS "priorMaxFileBytes", new_max_file_bytes AS "newMaxFileBytes",
            changed_by AS "changedBy", changed_at AS "changedAt", reason
       FROM administrator_kyc_upload_policy_audit ORDER BY changed_at DESC LIMIT 200`,
  );
  return rows;
}

// ------------------------------------------------------------ upload intents

export async function createAdministratorKycUploadIntent(actor: Actor, input: {
  administratorAccountId: string;
  evidenceKind: AdminKycEvidenceKind;
  jurisdictionCode: AdminKycJurisdiction;
  originalFilename: string;
  mimeType: (typeof MIME_TYPES)[number];
  sizeBytes: number;
  contentSha256: string;
  storageKey: string;
  ttlMinutes?: number;
}) {
  if (!SHA256_RE.test(input.contentSha256)) throw new Error("content_sha256 must be 64 lowercase hex chars");
  if (!MIME_TYPES.includes(input.mimeType)) throw new Error("unsupported mime_type");
  if (input.sizeBytes <= 0) throw new Error("size_bytes must be positive");
  const policy = await getAdministratorKycUploadPolicy();
  const maxBytes = policy?.maxFileBytes ?? 10485760;
  if (input.sizeBytes > maxBytes) {
    const exception = await getPool().query(
      `SELECT 1 FROM administrator_kyc_oversize_exceptions e
         JOIN administrator_kyc_upload_intents i ON i.id = e.upload_intent_id
        WHERE e.administrator_account_id=$1 AND i.content_sha256=$2`,
      [input.administratorAccountId, input.contentSha256],
    );
    if (exception.rowCount === 0) {
      throw new Error(`file exceeds administrator KYC upload policy (${maxBytes} bytes) and no oversize exception is recorded`);
    }
  }
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO administrator_kyc_upload_intents
       (administrator_account_id, evidence_kind, jurisdiction_code, original_filename, mime_type,
        size_bytes, content_sha256, storage_key, created_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now() + make_interval(mins => $10))
     RETURNING id`,
    [
      input.administratorAccountId, input.evidenceKind, input.jurisdictionCode,
      input.originalFilename, input.mimeType, input.sizeBytes, input.contentSha256,
      input.storageKey, actor.openId, input.ttlMinutes ?? 60,
    ],
  );
  return { id: rows[0].id };
}

export async function finalizeAdministratorKycUploadIntent(actor: Actor, intentId: string) {
  const { rowCount } = await getPool().query(
    `UPDATE administrator_kyc_upload_intents SET finalized_at=now()
      WHERE id=$1 AND finalized_at IS NULL AND expires_at > now()`,
    [intentId],
  );
  if (rowCount === 0) throw new Error("upload intent not found, already finalized, or expired");
}

export async function recordAdministratorKycOversizeException(actor: Actor, input: {
  uploadIntentId: string;
  administratorAccountId: string;
  jurisdictionCode: AdminKycJurisdiction;
  exceptionRationale: string;
}) {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO administrator_kyc_oversize_exceptions
       (upload_intent_id, administrator_account_id, jurisdiction_code, exception_rationale, accepted_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [input.uploadIntentId, input.administratorAccountId, input.jurisdictionCode, input.exceptionRationale, actor.openId],
  );
  return { id: rows[0].id };
}

// ------------------------------------------------------------------ evidence

export async function submitAdministratorKycEvidence(actor: Actor, input: {
  administratorAccountId: string;
  evidenceKind: AdminKycEvidenceKind;
  jurisdictionCode: AdminKycJurisdiction;
  referenceSha256: string;
}) {
  if (!SHA256_RE.test(input.referenceSha256)) throw new Error("reference_sha256 must be 64 lowercase hex chars");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO administrator_kyc_evidence
       (administrator_account_id, evidence_kind, jurisdiction_code, reference_sha256, supplied_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (administrator_account_id, evidence_kind, reference_sha256) DO NOTHING
     RETURNING id`,
    [input.administratorAccountId, input.evidenceKind, input.jurisdictionCode, input.referenceSha256, actor.openId],
  );
  return { id: rows[0]?.id ?? null };
}

export async function recordAdministratorKycReview(actor: Actor, input: {
  administratorAccountId: string;
  outcome: "approved" | "rejected" | "needs_information";
  rationale: string;
}) {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO administrator_kyc_reviews (administrator_account_id, outcome, rationale, reviewed_by)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [input.administratorAccountId, input.outcome, input.rationale, actor.openId],
  );
  return { id: rows[0].id };
}

// ---------------------------------------------- evidence requests + escalation

export async function createAdministratorKycEvidenceRequest(actor: Actor, input: {
  administratorAccountId: string;
  requestSummary: string;
  dueAt?: Date | null;
}) {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO administrator_kyc_evidence_requests
       (administrator_account_id, requested_by, request_summary, due_at)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [input.administratorAccountId, actor.openId, input.requestSummary, input.dueAt ?? null],
  );
  return { id: rows[0].id };
}

export async function transitionAdministratorKycEvidenceRequest(actor: Actor, input: {
  requestId: string;
  target: "submitted" | "resolved" | "closed";
}) {
  const { rowCount } = await getPool().query(
    `UPDATE administrator_kyc_evidence_requests
        SET status=$2,
            resolved_at=CASE WHEN $2 IN ('resolved','closed') THEN now() ELSE NULL END,
            closed_by=CASE WHEN $2='closed' THEN $3 ELSE closed_by END
      WHERE id=$1 AND status <> 'closed'`,
    [input.requestId, input.target, actor.openId],
  );
  if (rowCount === 0) throw new Error("evidence request not found or already closed");
}

export async function raiseAdministratorKycEscalation(actor: Actor, input: {
  administratorAccountId: string;
  reason: "sanctions_pep_concern" | "liveness_deepfake_concern" | "evidence_mismatch" | "single_evidence_exception" | "compliance_discretion";
}) {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO administrator_kyc_escalations (administrator_account_id, reason, raised_by)
     VALUES ($1,$2,$3) RETURNING id`,
    [input.administratorAccountId, input.reason, actor.openId],
  );
  return { id: rows[0].id };
}

/** Second review on an escalation must come from a different officer — enforced by DB trigger 0023. */
export async function recordAdministratorKycReviewEntry(actor: Actor, input: {
  administratorAccountId: string;
  escalationId?: string | null;
  reviewSequence: 1 | 2;
  outcome: "approved" | "rejected" | "needs_information";
  rationale: string;
}) {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO administrator_kyc_review_entries
       (administrator_account_id, escalation_id, review_sequence, outcome, rationale, reviewed_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.administratorAccountId, input.escalationId ?? null, input.reviewSequence, input.outcome, input.rationale, actor.openId],
  );
  return { id: rows[0].id };
}

// -------------------------------------------------------------------- reads

export async function getAdministratorKycWorkspace(accountId: string) {
  const pool = getPool();
  const [evidence, reviews, requests, escalations, entries, intents, exceptions] = await Promise.all([
    pool.query(`SELECT id, evidence_kind AS "evidenceKind", jurisdiction_code AS "jurisdictionCode",
                  reference_sha256 AS "referenceSha256", supplied_by AS "suppliedBy", supplied_at AS "suppliedAt"
             FROM administrator_kyc_evidence WHERE administrator_account_id=$1 ORDER BY supplied_at DESC`, [accountId]),
    pool.query(`SELECT id, outcome, rationale, reviewed_by AS "reviewedBy", reviewed_at AS "reviewedAt"
             FROM administrator_kyc_reviews WHERE administrator_account_id=$1 ORDER BY reviewed_at DESC`, [accountId]),
    pool.query(`SELECT id, request_summary AS "requestSummary", status, due_at AS "dueAt", created_at AS "createdAt",
                  resolved_at AS "resolvedAt", closed_by AS "closedBy"
             FROM administrator_kyc_evidence_requests WHERE administrator_account_id=$1 ORDER BY created_at DESC`, [accountId]),
    pool.query(`SELECT id, reason, raised_by AS "raisedBy", raised_at AS "raisedAt"
             FROM administrator_kyc_escalations WHERE administrator_account_id=$1 ORDER BY raised_at DESC`, [accountId]),
    pool.query(`SELECT id, escalation_id AS "escalationId", review_sequence AS "reviewSequence", outcome,
                  reviewed_by AS "reviewedBy", reviewed_at AS "reviewedAt"
             FROM administrator_kyc_review_entries WHERE administrator_account_id=$1 ORDER BY reviewed_at DESC`, [accountId]),
    pool.query(`SELECT id, evidence_kind AS "evidenceKind", original_filename AS "originalFilename", size_bytes AS "sizeBytes",
                  created_at AS "createdAt", expires_at AS "expiresAt", finalized_at AS "finalizedAt"
             FROM administrator_kyc_upload_intents WHERE administrator_account_id=$1 ORDER BY created_at DESC`, [accountId]),
    pool.query(`SELECT id, upload_intent_id AS "uploadIntentId", exception_rationale AS "exceptionRationale",
                  accepted_by AS "acceptedBy", accepted_at AS "acceptedAt"
             FROM administrator_kyc_oversize_exceptions WHERE administrator_account_id=$1 ORDER BY accepted_at DESC`, [accountId]),
  ]);
  return {
    evidence: evidence.rows,
    reviews: reviews.rows,
    evidenceRequests: requests.rows,
    escalations: escalations.rows,
    reviewEntries: entries.rows,
    uploadIntents: intents.rows,
    oversizeExceptions: exceptions.rows,
  };
}
