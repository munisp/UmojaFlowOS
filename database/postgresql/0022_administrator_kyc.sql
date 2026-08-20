DO $$ BEGIN
  CREATE TYPE administrator_kyc_evidence_kind AS ENUM ('identity_document', 'national_identity_reference', 'liveness_deepfake_assessment', 'sanctions_pep_review');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE administrator_kyc_review_outcome AS ENUM ('approved', 'rejected', 'needs_information');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE administrator_kyc_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  administrator_account_id UUID NOT NULL REFERENCES stakeholder_accounts(id) ON DELETE RESTRICT,
  evidence_kind administrator_kyc_evidence_kind NOT NULL,
  jurisdiction_code CHAR(2) NOT NULL CHECK (jurisdiction_code IN ('NG', 'KE', 'ZA', 'OTHER')),
  reference_sha256 CHAR(64) NOT NULL CHECK (reference_sha256 ~ '^[0-9a-f]{64}$'),
  supplied_by TEXT NOT NULL,
  supplied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (administrator_account_id, evidence_kind, reference_sha256)
);
CREATE TABLE administrator_kyc_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  administrator_account_id UUID NOT NULL REFERENCES stakeholder_accounts(id) ON DELETE RESTRICT,
  outcome administrator_kyc_review_outcome NOT NULL,
  rationale TEXT NOT NULL CHECK (char_length(rationale) BETWEEN 16 AND 4000),
  reviewed_by TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  external_verification_authoritative BOOLEAN NOT NULL DEFAULT FALSE CHECK (external_verification_authoritative = FALSE)
);
CREATE INDEX administrator_kyc_evidence_account_idx ON administrator_kyc_evidence (administrator_account_id, supplied_at DESC);
CREATE INDEX administrator_kyc_reviews_account_idx ON administrator_kyc_reviews (administrator_account_id, reviewed_at DESC);
