-- Market-region metadata supports truthful acquisition reporting and
-- jurisdiction-aware evidence selection. It does not determine a KYC/KYB
-- outcome, provider eligibility, regulatory status, or external authority.

ALTER TYPE kyc_document_type ADD VALUE IF NOT EXISTS 'ng_nin_reference';
ALTER TYPE kyc_document_type ADD VALUE IF NOT EXISTS 'ng_cac_registration';
ALTER TYPE kyc_document_type ADD VALUE IF NOT EXISTS 'ng_tax_identifier';
ALTER TYPE kyc_document_type ADD VALUE IF NOT EXISTS 'ng_director_identity';
ALTER TYPE kyc_document_type ADD VALUE IF NOT EXISTS 'ke_national_id_or_passport';
ALTER TYPE kyc_document_type ADD VALUE IF NOT EXISTS 'ke_business_registration_or_cr12';
ALTER TYPE kyc_document_type ADD VALUE IF NOT EXISTS 'ke_kra_pin';
ALTER TYPE kyc_document_type ADD VALUE IF NOT EXISTS 'ke_beneficial_ownership';
ALTER TYPE kyc_document_type ADD VALUE IF NOT EXISTS 'za_cipc_registration';
ALTER TYPE kyc_document_type ADD VALUE IF NOT EXISTS 'za_sars_tax_reference';
ALTER TYPE kyc_document_type ADD VALUE IF NOT EXISTS 'za_director_identity';

ALTER TABLE stakeholder_accounts
  ADD COLUMN IF NOT EXISTS market_region corridor_code,
  ADD COLUMN IF NOT EXISTS market_region_recorded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS market_region_source TEXT;

ALTER TABLE stakeholder_accounts
  DROP CONSTRAINT IF EXISTS stakeholder_accounts_market_region_metadata_check;
ALTER TABLE stakeholder_accounts
  ADD CONSTRAINT stakeholder_accounts_market_region_metadata_check
  CHECK (
    (market_region IS NULL AND market_region_recorded_at IS NULL AND market_region_source IS NULL)
    OR
    (market_region IS NOT NULL AND market_region_recorded_at IS NOT NULL
      AND market_region_source IN ('stakeholder_enrollment', 'administrator_correction'))
  );

ALTER TABLE kyc_documents
  ADD COLUMN IF NOT EXISTS market_region corridor_code;
ALTER TABLE kyc_document_upload_intents
  ADD COLUMN IF NOT EXISTS market_region corridor_code;

CREATE INDEX IF NOT EXISTS stakeholder_accounts_market_region_created_idx
  ON stakeholder_accounts (market_region, created_at DESC)
  WHERE market_region IS NOT NULL;
CREATE INDEX IF NOT EXISTS stakeholder_account_sessions_issued_idx
  ON stakeholder_account_sessions (issued_at DESC, stakeholder_account_id);
CREATE INDEX IF NOT EXISTS kyc_documents_market_region_idx
  ON kyc_documents (market_region, document_type, uploaded_at DESC)
  WHERE market_region IS NOT NULL;
CREATE INDEX IF NOT EXISTS kyc_document_upload_intents_market_region_idx
  ON kyc_document_upload_intents (market_region, document_type, expires_at DESC)
  WHERE market_region IS NOT NULL;
