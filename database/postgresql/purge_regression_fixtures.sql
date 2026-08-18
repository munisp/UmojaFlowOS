-- Removes every record created by the automated regression suites.
--
-- The suites deliberately create real rows rather than mocks, so this script is
-- the counterpart that keeps the canonical database free of synthetic
-- operational data. It is written to be idempotent and safe to run at any
-- time: it matches only the fixture naming prefixes the suites use, and it
-- deletes in dependency order so foreign keys are never violated.
--
-- Run as the schema owner:
--   sudo -u postgres psql -q -d umojaflowos_dev -f - < purge_regression_fixtures.sql

BEGIN;

-- Fixture naming patterns used across the regression suites. Any new suite
-- MUST use one of these prefixes so its rows are purgeable.
CREATE TEMP TABLE fixture_patterns (pattern text) ON COMMIT DROP;
INSERT INTO fixture_patterns (pattern) VALUES
  ('regression-%'),
  ('Regression %'),
  ('% Regression %'),
  ('Provenance regression%'),
  ('Checksum Guard%'),
  ('Lifecycle %'),
  ('Cutover %'),
  ('Audit Trail%'),
  ('Consent Regression%'),
  ('Boundary Regression%');

-- Actor subject prefixes used by the suites when acting as an operator. These
-- are synthetic subjects that never correspond to a real authenticated user.
CREATE TEMP TABLE fixture_actors (pattern text) ON COMMIT DROP;
INSERT INTO fixture_actors (pattern) VALUES
  ('regression-%'),
  ('provenance-%'),
  ('canonical-provenance-%'),
  ('fallback-%'),
  ('incomplete-%'),
  ('audit-officer-%'),
  ('audit-subject-%'),
  ('canonical-%'),
  ('registry-admin-%'),
  ('kyc-lifecycle-%'),
  ('kyc-%'),
  ('lifecycle-%'),
  ('cutover-%'),
  ('boundary-%'),
  ('treasury-regression-%'),
  ('compliance-regression-%');

CREATE TEMP TABLE fixture_customers (id uuid) ON COMMIT DROP;
INSERT INTO fixture_customers (id)
SELECT c.id FROM customers c
WHERE EXISTS (SELECT 1 FROM fixture_patterns p WHERE c.legal_name LIKE p.pattern);

CREATE TEMP TABLE fixture_counterparties (id uuid) ON COMMIT DROP;
INSERT INTO fixture_counterparties (id)
SELECT c.id FROM counterparties c
WHERE EXISTS (SELECT 1 FROM fixture_patterns p WHERE c.legal_name LIKE p.pattern);

CREATE TEMP TABLE fixture_orders (id uuid) ON COMMIT DROP;
INSERT INTO fixture_orders (id)
SELECT o.id FROM payment_orders o
WHERE o.customer_id IN (SELECT id FROM fixture_customers)
   OR EXISTS (SELECT 1 FROM fixture_patterns p WHERE o.idempotency_key LIKE p.pattern);

CREATE TEMP TABLE fixture_consents (id uuid) ON COMMIT DROP;
INSERT INTO fixture_consents (id)
SELECT c.id FROM verification_consents c
WHERE EXISTS (SELECT 1 FROM fixture_actors a WHERE c.captured_by LIKE a.pattern)
   OR EXISTS (SELECT 1 FROM fixture_actors a WHERE c.subject_reference LIKE a.pattern)
   OR EXISTS (SELECT 1 FROM fixture_patterns p WHERE c.subject_reference LIKE p.pattern);

CREATE TEMP TABLE fixture_jobs (id uuid) ON COMMIT DROP;
INSERT INTO fixture_jobs (id)
SELECT j.id FROM document_analysis_jobs j
WHERE j.consent_id IN (SELECT id FROM fixture_consents)
   OR EXISTS (SELECT 1 FROM fixture_actors a WHERE j.submitted_by LIKE a.pattern)
   OR j.kyc_document_id IN (SELECT id FROM kyc_documents WHERE customer_id IN (SELECT id FROM fixture_customers));

CREATE TEMP TABLE fixture_deadlines (id uuid) ON COMMIT DROP;
INSERT INTO fixture_deadlines (id)
SELECT d.id FROM regulatory_deadlines d
WHERE EXISTS (SELECT 1 FROM fixture_patterns p WHERE d.title LIKE p.pattern);

-- Compliance cases created by the suites are identified by their source
-- reference, since a case need not be linked to a fixture customer.
CREATE TEMP TABLE fixture_cases (id uuid) ON COMMIT DROP;
INSERT INTO fixture_cases (id)
SELECT c.id FROM compliance_cases c
WHERE c.source_reference LIKE 'regression-case://%'
   OR c.source_reference LIKE 'case://regression%'
   OR c.customer_id IN (SELECT id FROM fixture_customers);

-- Reporting legal entities registered by the suites use a "regression-" prefixed
-- registrar identifier, and their regulatory reports are collected with them.
CREATE TEMP TABLE fixture_entities (id uuid) ON COMMIT DROP;
INSERT INTO fixture_entities (id)
SELECT e.id FROM legal_entities e
WHERE e.registration_identifier LIKE 'regression-%'
   OR EXISTS (SELECT 1 FROM fixture_patterns p WHERE e.legal_name LIKE p.pattern);

CREATE TEMP TABLE fixture_reports (id uuid) ON COMMIT DROP;
INSERT INTO fixture_reports (id)
SELECT r.id FROM regulatory_reports r
WHERE r.legal_entity_id IN (SELECT id FROM fixture_entities);

-- Leaf-to-root deletion.
DELETE FROM verification_reviewer_decisions WHERE analysis_job_id IN (SELECT id FROM fixture_jobs);
DELETE FROM document_analysis_evidence WHERE analysis_job_id IN (SELECT id FROM fixture_jobs);
DELETE FROM document_analysis_jobs WHERE id IN (SELECT id FROM fixture_jobs);
DELETE FROM kyc_document_upload_intents WHERE customer_id IN (SELECT id FROM fixture_customers);
DELETE FROM kyc_documents WHERE customer_id IN (SELECT id FROM fixture_customers);
DELETE FROM verification_consents WHERE id IN (SELECT id FROM fixture_consents);
DELETE FROM sar_str_filings WHERE compliance_case_id IN (SELECT id FROM fixture_cases);
DELETE FROM compliance_cases WHERE id IN (SELECT id FROM fixture_cases);
DELETE FROM payment_legs WHERE payment_order_id IN (SELECT id FROM fixture_orders) OR counterparty_id IN (SELECT id FROM fixture_counterparties);
DELETE FROM payment_orders WHERE id IN (SELECT id FROM fixture_orders);
DELETE FROM rate_locks WHERE payment_order_id IN (SELECT id FROM fixture_orders);
DELETE FROM rate_locks WHERE market_observation_id IN (
  SELECT o.id FROM market_observations o WHERE o.integration_connection_id IN (
    SELECT i.id FROM integration_connections i WHERE i.counterparty_id IN (SELECT id FROM fixture_counterparties)
  )
);
DELETE FROM market_observations WHERE integration_connection_id IN (
  SELECT i.id FROM integration_connections i WHERE i.counterparty_id IN (SELECT id FROM fixture_counterparties)
);
DELETE FROM integration_connections WHERE counterparty_id IN (SELECT id FROM fixture_counterparties);
DELETE FROM counterparty_risk_assessments WHERE counterparty_id IN (SELECT id FROM fixture_counterparties);
DELETE FROM counterparty_authorizations WHERE counterparty_id IN (SELECT id FROM fixture_counterparties);
DELETE FROM beneficiaries WHERE customer_id IN (SELECT id FROM fixture_customers);
DELETE FROM regulatory_deadlines WHERE id IN (SELECT id FROM fixture_deadlines);
DELETE FROM regulatory_reports WHERE id IN (SELECT id FROM fixture_reports);
DELETE FROM counterparty_authorizations WHERE legal_entity_id IN (SELECT id FROM fixture_entities);

-- Activity events reference their subject by object_id, so they are cleared for
-- every fixture object identifier collected above.
DELETE FROM activity_events WHERE object_id IN (
  SELECT id FROM fixture_customers
  UNION ALL SELECT id FROM fixture_counterparties
  UNION ALL SELECT id FROM fixture_orders
  UNION ALL SELECT id FROM fixture_jobs
  UNION ALL SELECT id FROM fixture_deadlines
  UNION ALL SELECT id FROM fixture_cases
  UNION ALL SELECT id FROM fixture_entities
  UNION ALL SELECT id FROM fixture_reports
);
DELETE FROM activity_events WHERE EXISTS (SELECT 1 FROM fixture_actors a WHERE activity_events.actor_subject LIKE a.pattern);

DELETE FROM customers WHERE id IN (SELECT id FROM fixture_customers);
DELETE FROM counterparties WHERE id IN (SELECT id FROM fixture_counterparties);
DELETE FROM legal_entities WHERE id IN (SELECT id FROM fixture_entities);

COMMIT;
