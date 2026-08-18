-- CBN, CBK, and SARB reporting workflow controls. Submission remains provider-gated.

ALTER TYPE report_status ADD VALUE IF NOT EXISTS 'under_review' AFTER 'draft';
ALTER TYPE report_status ADD VALUE IF NOT EXISTS 'approved' AFTER 'under_review';

BEGIN;

ALTER TABLE regulatory_reports
  ADD COLUMN IF NOT EXISTS reviewed_by TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by TEXT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS status_reason TEXT;

ALTER TABLE regulatory_reports
  ADD CONSTRAINT regulatory_reports_review_gate CHECK (
    status NOT IN ('under_review', 'approved', 'pending_submission', 'submitted')
    OR (artifact_uri IS NOT NULL AND evidence_manifest IS NOT NULL)
  );

ALTER TABLE regulatory_reports
  ADD CONSTRAINT regulatory_reports_submission_gate CHECK (
    status <> 'submitted' OR (submission_reference IS NOT NULL AND length(trim(submission_reference)) > 0)
  );

CREATE INDEX IF NOT EXISTS regulatory_reports_workflow_idx ON regulatory_reports (regulator, corridor, status, period_end DESC);

COMMIT;
