DO $$ BEGIN
  CREATE TYPE administrator_kyc_request_status AS ENUM ('open', 'submitted', 'resolved', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE administrator_kyc_escalation_reason AS ENUM ('sanctions_pep_concern', 'liveness_deepfake_concern', 'evidence_mismatch', 'single_evidence_exception', 'compliance_discretion');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE administrator_kyc_upload_policy (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  max_file_bytes INTEGER NOT NULL DEFAULT 10485760 CHECK (max_file_bytes BETWEEN 1048576 AND 52428800),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  update_reason TEXT NOT NULL CHECK (char_length(update_reason) BETWEEN 16 AND 2000)
);

CREATE TABLE administrator_kyc_upload_policy_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prior_max_file_bytes INTEGER NOT NULL CHECK (prior_max_file_bytes BETWEEN 1048576 AND 52428800),
  new_max_file_bytes INTEGER NOT NULL CHECK (new_max_file_bytes BETWEEN 1048576 AND 52428800),
  changed_by TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 16 AND 2000)
);

CREATE TABLE administrator_kyc_evidence_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  administrator_account_id UUID NOT NULL REFERENCES stakeholder_accounts(id) ON DELETE RESTRICT,
  requested_by TEXT NOT NULL,
  request_summary TEXT NOT NULL CHECK (char_length(request_summary) BETWEEN 8 AND 2000),
  due_at TIMESTAMPTZ,
  status administrator_kyc_request_status NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  closed_by TEXT,
  CHECK ((status IN ('open', 'submitted') AND resolved_at IS NULL) OR status IN ('resolved', 'closed'))
);

CREATE TABLE administrator_kyc_escalations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  administrator_account_id UUID NOT NULL REFERENCES stakeholder_accounts(id) ON DELETE RESTRICT,
  reason administrator_kyc_escalation_reason NOT NULL,
  raised_by TEXT NOT NULL,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  requires_independent_second_review BOOLEAN NOT NULL DEFAULT TRUE CHECK (requires_independent_second_review = TRUE),
  administrator_status TEXT NOT NULL DEFAULT 'additional_review_required' CHECK (administrator_status = 'additional_review_required')
);

CREATE TABLE administrator_kyc_review_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  administrator_account_id UUID NOT NULL REFERENCES stakeholder_accounts(id) ON DELETE RESTRICT,
  escalation_id UUID REFERENCES administrator_kyc_escalations(id) ON DELETE RESTRICT,
  review_sequence SMALLINT NOT NULL CHECK (review_sequence IN (1, 2)),
  outcome administrator_kyc_review_outcome NOT NULL,
  rationale TEXT NOT NULL CHECK (char_length(rationale) BETWEEN 16 AND 4000),
  reviewed_by TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (administrator_account_id, escalation_id, review_sequence)
);

CREATE OR REPLACE FUNCTION enforce_independent_administrator_kyc_second_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.review_sequence = 2 AND EXISTS (
    SELECT 1 FROM administrator_kyc_review_entries first_review
    WHERE first_review.administrator_account_id = NEW.administrator_account_id
      AND first_review.escalation_id IS NOT DISTINCT FROM NEW.escalation_id
      AND first_review.review_sequence = 1
      AND first_review.reviewed_by = NEW.reviewed_by
  ) THEN
    RAISE EXCEPTION 'second administrator KYC review must be performed by a different compliance officer';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER administrator_kyc_independent_second_review
BEFORE INSERT ON administrator_kyc_review_entries
FOR EACH ROW EXECUTE FUNCTION enforce_independent_administrator_kyc_second_review();

INSERT INTO administrator_kyc_upload_policy (id, max_file_bytes, updated_by, update_reason)
VALUES (TRUE, 10485760, 'system-bootstrap', 'Initial conservative administrator KYC upload-size policy.')
ON CONFLICT (id) DO NOTHING;

CREATE INDEX administrator_kyc_request_account_idx ON administrator_kyc_evidence_requests(administrator_account_id, status, created_at DESC);
CREATE INDEX administrator_kyc_escalation_account_idx ON administrator_kyc_escalations(administrator_account_id, raised_at DESC);
CREATE INDEX administrator_kyc_review_entry_account_idx ON administrator_kyc_review_entries(administrator_account_id, reviewed_at DESC);
