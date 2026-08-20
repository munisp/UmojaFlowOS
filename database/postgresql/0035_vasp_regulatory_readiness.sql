CREATE TYPE vasp_supervisory_path AS ENUM ('sec_arip', 'sec_full_registration', 'other_supervisory_path');
CREATE TYPE vasp_supervisory_evidence_category AS ENUM (
  'incorporation_and_governing_documents',
  'resident_leadership_and_principal_officers',
  'legal_adviser_or_solicitor',
  'nfiu_registration',
  'financial_capacity_and_fidelity_bond',
  'aml_cft_cpf_and_travel_rule_programme',
  'technology_and_cybersecurity_controls',
  'consumer_protection_and_complaint_handling',
  'operational_reporting_and_incident_plan',
  'transition_or_orderly_exit_plan'
);
CREATE TYPE vasp_travel_rule_evidence_category AS ENUM (
  'originator_information_schema',
  'beneficiary_information_schema',
  'secure_counterparty_exchange_design',
  'counterparty_identity_and_authorisation',
  'exception_and_rejection_handling'
);
CREATE TYPE vasp_readiness_outcome AS ENUM ('internal_record_incomplete', 'internal_record_complete_pending_external_review');

CREATE TABLE vasp_regulatory_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL UNIQUE REFERENCES cbn_sandbox_dossiers(id),
  supervisory_path vasp_supervisory_path NOT NULL,
  operational_model_summary TEXT NOT NULL CHECK (char_length(operational_model_summary) BETWEEN 50 AND 4000),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (supervisory_path IN ('sec_arip', 'sec_full_registration', 'other_supervisory_path'))
);

CREATE TABLE vasp_regulatory_evidence_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES vasp_regulatory_profiles(id),
  category vasp_supervisory_evidence_category NOT NULL,
  evidence_uri TEXT NOT NULL CHECK (evidence_uri ~ '^https://'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (profile_id, category, evidence_sha256)
);

CREATE TABLE vasp_travel_rule_evidence_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES cbn_sandbox_dossiers(id),
  counterparty_id UUID NOT NULL REFERENCES counterparties(id),
  category vasp_travel_rule_evidence_category NOT NULL,
  evidence_uri TEXT NOT NULL CHECK (evidence_uri ~ '^https://'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dossier_id, counterparty_id, category, evidence_sha256)
);

CREATE TABLE vasp_travel_rule_route_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES cbn_sandbox_dossiers(id),
  counterparty_id UUID NOT NULL REFERENCES counterparties(id),
  required_categories JSONB NOT NULL,
  recorded_categories JSONB NOT NULL,
  missing_categories JSONB NOT NULL,
  outcome vasp_readiness_outcome NOT NULL,
  reviewer_rationale TEXT NOT NULL CHECK (char_length(reviewer_rationale) BETWEEN 20 AND 4000),
  assessed_by TEXT NOT NULL,
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  external_counterparty_verification BOOLEAN NOT NULL DEFAULT false CHECK (external_counterparty_verification = false),
  external_transmission BOOLEAN NOT NULL DEFAULT false CHECK (external_transmission = false),
  UNIQUE (id, dossier_id, counterparty_id)
);

CREATE INDEX vasp_regulatory_evidence_profile_idx ON vasp_regulatory_evidence_items (profile_id, category, recorded_at DESC);
CREATE INDEX vasp_travel_rule_evidence_route_idx ON vasp_travel_rule_evidence_items (dossier_id, counterparty_id, category, recorded_at DESC);
CREATE INDEX vasp_travel_rule_assessments_route_idx ON vasp_travel_rule_route_assessments (dossier_id, counterparty_id, assessed_at DESC);
