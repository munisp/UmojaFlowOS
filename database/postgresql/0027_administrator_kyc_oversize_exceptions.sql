CREATE TABLE administrator_kyc_oversize_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_intent_id UUID NOT NULL UNIQUE REFERENCES administrator_kyc_upload_intents(id) ON DELETE RESTRICT,
  administrator_account_id UUID NOT NULL REFERENCES stakeholder_accounts(id) ON DELETE RESTRICT,
  jurisdiction_code CHAR(2) NOT NULL CHECK (jurisdiction_code IN ('NG', 'KE', 'ZA', 'OTHER')),
  exception_rationale TEXT NOT NULL CHECK (char_length(trim(exception_rationale)) BETWEEN 16 AND 4000),
  accepted_by TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX administrator_kyc_oversize_exceptions_account_idx
  ON administrator_kyc_oversize_exceptions (administrator_account_id, accepted_at DESC);
