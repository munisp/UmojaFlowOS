BEGIN;

CREATE TYPE vasp_readiness_assurance_area AS ENUM (
  'controlled_live_test',
  'governance_legal_ownership',
  'aml_cft_cpf_operations',
  'customer_asset_safeguarding',
  'cybersecurity_resilience',
  'consumer_incident_reporting'
);

CREATE TYPE vasp_readiness_assurance_status AS ENUM (
  'open',
  'evidence_recorded',
  'externally_verified',
  'rejected'
);

CREATE TABLE vasp_readiness_assurance_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES cbn_sandbox_dossiers(id) ON DELETE RESTRICT,
  area vasp_readiness_assurance_area NOT NULL,
  max_points SMALLINT NOT NULL CHECK (max_points IN (6, 7, 8, 10, 13, 14)),
  required_evidence TEXT NOT NULL CHECK (length(trim(required_evidence)) >= 30),
  accountable_owner_role TEXT NOT NULL CHECK (length(trim(accountable_owner_role)) >= 3),
  status vasp_readiness_assurance_status NOT NULL DEFAULT 'open',
  evidence_uri TEXT CHECK (evidence_uri IS NULL OR evidence_uri ~ '^https://'),
  evidence_sha256 CHAR(64) CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_recorded_by TEXT,
  evidence_recorded_at TIMESTAMPTZ,
  external_verifier TEXT,
  external_attestation_uri TEXT CHECK (external_attestation_uri IS NULL OR external_attestation_uri ~ '^https://'),
  external_attestation_sha256 CHAR(64) CHECK (external_attestation_sha256 IS NULL OR external_attestation_sha256 ~ '^[a-f0-9]{64}$'),
  verified_by TEXT,
  verified_at TIMESTAMPTZ,
  verification_rationale TEXT,
  rejection_rationale TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dossier_id, area),
  CHECK (
    (status = 'open' AND evidence_uri IS NULL AND evidence_sha256 IS NULL AND evidence_recorded_by IS NULL AND evidence_recorded_at IS NULL AND external_verifier IS NULL AND external_attestation_uri IS NULL AND external_attestation_sha256 IS NULL AND verified_by IS NULL AND verified_at IS NULL AND verification_rationale IS NULL AND rejection_rationale IS NULL)
    OR
    (status = 'evidence_recorded' AND evidence_uri IS NOT NULL AND evidence_sha256 IS NOT NULL AND evidence_recorded_by IS NOT NULL AND evidence_recorded_at IS NOT NULL AND external_verifier IS NULL AND external_attestation_uri IS NULL AND external_attestation_sha256 IS NULL AND verified_by IS NULL AND verified_at IS NULL AND verification_rationale IS NULL AND rejection_rationale IS NULL)
    OR
    (status = 'externally_verified' AND evidence_uri IS NOT NULL AND evidence_sha256 IS NOT NULL AND evidence_recorded_by IS NOT NULL AND evidence_recorded_at IS NOT NULL AND external_verifier IS NOT NULL AND external_attestation_uri IS NOT NULL AND external_attestation_sha256 IS NOT NULL AND verified_by IS NOT NULL AND verified_at IS NOT NULL AND verification_rationale IS NOT NULL AND rejection_rationale IS NULL AND verified_by <> evidence_recorded_by)
    OR
    (status = 'rejected' AND evidence_uri IS NOT NULL AND evidence_sha256 IS NOT NULL AND evidence_recorded_by IS NOT NULL AND evidence_recorded_at IS NOT NULL AND rejection_rationale IS NOT NULL)
  )
);

CREATE INDEX vasp_readiness_assurance_items_dossier_idx
  ON vasp_readiness_assurance_items (dossier_id, status, area);

REVOKE ALL ON vasp_readiness_assurance_items FROM PUBLIC;
-- Application privileges are granted by the parameterised canonical
-- database/postgresql/grants.sql script. The migration remains portable across
-- development, staging, and production role names.

COMMIT;
