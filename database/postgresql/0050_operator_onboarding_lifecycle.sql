BEGIN;

-- OM Ch.11 (Internal Operations Users) is not present in the shared export
-- beyond its title in the table of contents. This migration is built from
-- the one place its content does survive: the "Internal ops users" lane of
-- the Figure 3.1 cross-stakeholder map (Ch.3), which names four phase-steps
-- -- role+access request/SoD matrix, LMS enrolment/cert assignment, shadow
-- period/first-ticket supervision, annual recert/access review -- each with
-- an owner. Treated as inferred, not sourced verbatim like every other
-- chapter's build in this series.
--
-- Distinct in kind from every counterparty chapter (4-9): this lifecycle
-- tracks the platform's own operators (admin/compliance_officer/
-- treasury_operator/auditor accounts), not an external counterparty, so it
-- is scoped by `subject` (the Keycloak-derived platform identity already
-- used by user_role_assignments and operator_role_assignments) rather than
-- a counterparties row, and has no evidence pack or licence concept.
CREATE TYPE operator_onboarding_phase AS ENUM ('role_access_request', 'lms_enrolment', 'shadow_period', 'steady_state');

CREATE TABLE operator_onboarding_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject TEXT NOT NULL,
  phase operator_onboarding_phase NOT NULL DEFAULT 'role_access_request',
  sod_matrix_reviewed BOOLEAN NOT NULL DEFAULT false,
  sod_matrix_reviewed_by TEXT,
  sod_matrix_reviewed_at TIMESTAMPTZ,
  sod_matrix_note TEXT,
  lms_cert_reference TEXT,
  lms_cert_assigned_at TIMESTAMPTZ,
  shadow_period_supervised_by TEXT,
  shadow_period_started_at TIMESTAMPTZ,
  shadow_period_ended_at TIMESTAMPTZ,
  steady_state_activated_at TIMESTAMPTZ,
  next_recert_due_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX operator_onboarding_records_subject_idx ON operator_onboarding_records (subject, created_at DESC);

COMMIT;
