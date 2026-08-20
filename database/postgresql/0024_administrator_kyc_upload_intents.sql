CREATE TABLE administrator_kyc_upload_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  administrator_account_id UUID NOT NULL REFERENCES stakeholder_accounts(id) ON DELETE RESTRICT,
  evidence_kind administrator_kyc_evidence_kind NOT NULL,
  jurisdiction_code CHAR(2) NOT NULL CHECK (jurisdiction_code IN ('NG', 'KE', 'ZA', 'OTHER')),
  original_filename TEXT NOT NULL CHECK (char_length(original_filename) BETWEEN 1 AND 180),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  storage_key TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  finalized_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);
CREATE INDEX administrator_kyc_upload_intents_account_idx
  ON administrator_kyc_upload_intents (administrator_account_id, created_at DESC);
