-- Dedicated segregation-of-duties exception monitoring.
-- This migration creates detection/alert evidence only. It never verifies a readiness
-- item, changes a provider state, approves a payment, or grants regulatory authority.

BEGIN;

-- The monitor is an internal scheduler identity, not an administrator/auditor user.
ALTER TYPE operating_role ADD VALUE IF NOT EXISTS 'system_monitor';

ALTER TABLE alert_policies
  DROP CONSTRAINT alert_policies_alert_type_check;
ALTER TABLE alert_policies
  ADD CONSTRAINT alert_policies_alert_type_check
  CHECK (alert_type IN (
    'liquidity_threshold',
    'payment_failure',
    'compliance_flag',
    'regulatory_deadline',
    'segregation_of_duties'
  ));

ALTER TABLE compliance_alerts
  DROP CONSTRAINT compliance_alerts_alert_type_check;
ALTER TABLE compliance_alerts
  ADD CONSTRAINT compliance_alerts_alert_type_check
  CHECK (alert_type IN (
    'liquidity_threshold',
    'payment_failure',
    'compliance_flag',
    'regulatory_deadline',
    'segregation_of_duties'
  ));

CREATE TYPE segregation_of_duties_evaluation_state AS ENUM (
  'clean',
  'exceptions_detected',
  'indeterminate'
);

CREATE TABLE segregation_of_duties_evaluation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  evaluator_subject TEXT NOT NULL,
  evaluator_role operating_role NOT NULL,
  query_version TEXT NOT NULL CHECK (length(trim(query_version)) >= 3),
  evaluation_state segregation_of_duties_evaluation_state NOT NULL,
  exception_count INTEGER NOT NULL CHECK (exception_count >= 0),
  exception_digest CHAR(64) CHECK (exception_digest IS NULL OR exception_digest ~ '^[a-f0-9]{64}$'),
  error_summary TEXT,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (evaluation_state = 'clean' AND exception_count = 0 AND exception_digest IS NOT NULL AND error_summary IS NULL)
    OR
    (evaluation_state = 'exceptions_detected' AND exception_count > 0 AND exception_digest IS NOT NULL AND error_summary IS NULL)
    OR
    (evaluation_state = 'indeterminate' AND exception_count = 0 AND exception_digest IS NULL AND error_summary IS NOT NULL AND length(trim(error_summary)) >= 8)
  )
);

CREATE INDEX segregation_of_duties_evaluation_runs_state_idx
  ON segregation_of_duties_evaluation_runs (evaluation_state, evaluated_at DESC);

REVOKE ALL ON segregation_of_duties_evaluation_runs FROM PUBLIC;

COMMIT;
