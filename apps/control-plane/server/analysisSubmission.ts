import { Pool } from "pg";
import { registerTestResource } from "./testResourceRegistry";

let pool: Pool | undefined;
function getPool() {
  if (!pool) {
    pool = registerTestResource(
      process.env.POSTGRES_DATABASE_URL
        ? new Pool({ connectionString: process.env.POSTGRES_DATABASE_URL })
        : new Pool({
            host: "/var/run/postgresql",
            database: process.env.POSTGRES_TEST_DATABASE ?? "umoja_test",
            user: process.env.POSTGRES_LOCAL_USER ?? "ubuntu",
          }),
    );
  }
  return pool;
}

/**
 * Consents that are currently usable as a lawful basis for analysis.
 *
 * A consent is usable only while it is neither revoked nor expired. Filtering
 * in SQL rather than in the console means a revoked consent disappears from the
 * submission surface immediately, and the server-side guard still re-checks it.
 */
export async function listPostgresActiveVerificationConsents() {
  const { rows } = await getPool().query<{
    id: string;
    scope: "kyc" | "kyb";
    subjectReference: string;
    consentVersion: string;
    purpose: string;
    grantedAt: Date;
    expiresAt: Date | null;
  }>(
    `SELECT id, scope, subject_reference AS "subjectReference", consent_version AS "consentVersion",
            purpose, granted_at AS "grantedAt", expires_at AS "expiresAt"
       FROM verification_consents
      WHERE revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY granted_at DESC`,
  );
  return rows;
}

/**
 * Stored KYC documents that carry everything an analysis job requires: a
 * verified content digest from the finalised upload intent, a storage
 * reference, and an accepted document MIME type.
 *
 * Documents whose upload was never finalised have no verified digest, so they
 * are excluded: submitting them would mean analysing bytes whose integrity was
 * never confirmed.
 */
export async function listPostgresAnalysisReadyDocuments() {
  const { rows } = await getPool().query<{
    id: string;
    customerLegalName: string;
    documentType: string;
    storageUrl: string;
    mimeType: string;
    contentSha256: string;
    reviewStatus: string;
    uploadedAt: Date;
  }>(
    `SELECT document.id,
            customer.legal_name AS "customerLegalName",
            document.document_type AS "documentType",
            document.storage_url AS "storageUrl",
            document.mime_type AS "mimeType",
            intent.content_sha256 AS "contentSha256",
            document.review_status AS "reviewStatus",
            document.uploaded_at AS "uploadedAt"
       FROM kyc_documents document
       JOIN customers customer ON customer.id = document.customer_id
       JOIN kyc_document_upload_intents intent
         ON intent.storage_key = document.storage_key
        AND intent.finalized_at IS NOT NULL
      WHERE document.mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/tiff')
      ORDER BY document.uploaded_at DESC`,
  );
  return rows;
}
