CREATE TYPE imto_readiness_evidence_category AS ENUM (
  'cbn_imto_licence_or_application',
  'permitted_remittance_scope',
  'settlement_account_and_authorised_bank',
  'aml_cft_cpf_and_sanctions_programme',
  'customer_disclosure_and_complaints',
  'agent_fintech_and_partner_oversight',
  'reconciliation_and_safeguarding',
  'incident_reporting_and_business_continuity',
  'controlled_test_and_wind_down'
);
CREATE TYPE imto_readiness_outcome AS ENUM ('internal_record_incomplete','internal_record_complete_pending_external_review');

CREATE TABLE imto_readiness_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id UUID NOT NULL UNIQUE REFERENCES legal_entities(id),
  corridor corridor_code NOT NULL DEFAULT 'NIGERIA_NGN',
  operating_model_summary TEXT NOT NULL CHECK (char_length(operating_model_summary) BETWEEN 50 AND 4000),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  licence_claimed BOOLEAN NOT NULL DEFAULT false CHECK (licence_claimed = false),
  remittance_execution_authority BOOLEAN NOT NULL DEFAULT false CHECK (remittance_execution_authority = false),
  settlement_authority BOOLEAN NOT NULL DEFAULT false CHECK (settlement_authority = false)
);
CREATE TABLE imto_readiness_evidence_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES imto_readiness_profiles(id),
  category imto_readiness_evidence_category NOT NULL,
  evidence_uri TEXT NOT NULL CHECK (evidence_uri ~ '^https://'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(profile_id,category,evidence_sha256)
);
CREATE TABLE imto_readiness_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES imto_readiness_profiles(id),
  required_categories JSONB NOT NULL, recorded_categories JSONB NOT NULL, missing_categories JSONB NOT NULL,
  outcome imto_readiness_outcome NOT NULL,
  reviewer_rationale TEXT NOT NULL CHECK (char_length(reviewer_rationale) BETWEEN 20 AND 4000),
  assessed_by TEXT NOT NULL, assessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  external_licence_verification BOOLEAN NOT NULL DEFAULT false CHECK (external_licence_verification = false),
  provider_activation BOOLEAN NOT NULL DEFAULT false CHECK (provider_activation = false),
  remittance_execution BOOLEAN NOT NULL DEFAULT false CHECK (remittance_execution = false),
  settlement_execution BOOLEAN NOT NULL DEFAULT false CHECK (settlement_execution = false)
);
CREATE INDEX imto_readiness_evidence_idx ON imto_readiness_evidence_items(profile_id,category,recorded_at DESC);
