-- Direct-to-S3 KYC document ingestion control. PostgreSQL stores metadata and immutable audit evidence only.

BEGIN;

CREATE TABLE kyc_document_upload_intents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id),
    document_type kyc_document_type NOT NULL,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/tiff')),
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
    content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
    storage_key TEXT NOT NULL UNIQUE,
    uploaded_by TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    finalized_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);

CREATE INDEX kyc_document_upload_intents_pending_idx
  ON kyc_document_upload_intents (uploaded_by, expires_at)
  WHERE finalized_at IS NULL;

COMMIT;
