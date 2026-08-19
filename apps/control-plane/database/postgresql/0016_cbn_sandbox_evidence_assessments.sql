CREATE TYPE cbn_sandbox_assessment_outcome AS ENUM (
  'internal_record_incomplete',
  'internal_record_complete_pending_external_review',
  'internal_record_inconsistent'
);

CREATE TABLE cbn_sandbox_evidence_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES cbn_sandbox_dossiers(id),
  assessment_scope TEXT NOT NULL DEFAULT 'dossier_evidence_completeness' CHECK (assessment_scope = 'dossier_evidence_completeness'),
  required_categories JSONB NOT NULL CHECK (jsonb_typeof(required_categories) = 'array'),
  recorded_categories JSONB NOT NULL CHECK (jsonb_typeof(recorded_categories) = 'array'),
  missing_categories JSONB NOT NULL CHECK (jsonb_typeof(missing_categories) = 'array'),
  inconsistency_codes JSONB NOT NULL CHECK (jsonb_typeof(inconsistency_codes) = 'array'),
  documented_test_plan BOOLEAN NOT NULL,
  outcome cbn_sandbox_assessment_outcome NOT NULL,
  reviewer_rationale TEXT NOT NULL CHECK (char_length(reviewer_rationale) BETWEEN 20 AND 4000),
  external_eligibility BOOLEAN NOT NULL DEFAULT FALSE CHECK (external_eligibility = FALSE),
  external_submission BOOLEAN NOT NULL DEFAULT FALSE CHECK (external_submission = FALSE),
  admission BOOLEAN NOT NULL DEFAULT FALSE CHECK (admission = FALSE),
  licence BOOLEAN NOT NULL DEFAULT FALSE CHECK (licence = FALSE),
  provider_activation BOOLEAN NOT NULL DEFAULT FALSE CHECK (provider_activation = FALSE),
  assessed_by TEXT NOT NULL,
  assessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cbn_sandbox_evidence_assessments_dossier_idx
  ON cbn_sandbox_evidence_assessments (dossier_id, assessed_at DESC);
