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
  ('compliance-regression-%'),
  -- The credential-configuration and activation suites act as `admin-<uuid>`.
  -- A real administrator is identified by an OAuth open id, never by a
  -- generated UUID, so this prefix is unambiguously synthetic. The underscore
  -- wildcards pin it to exactly the UUID shape.
  ('admin-________-____-____-____-____________');

CREATE TEMP TABLE fixture_customers (id uuid) ON COMMIT DROP;
INSERT INTO fixture_customers (id)
SELECT c.id FROM customers c
WHERE EXISTS (SELECT 1 FROM fixture_patterns p WHERE c.legal_name LIKE p.pattern);

CREATE TEMP TABLE fixture_counterparties (id uuid) ON COMMIT DROP;
INSERT INTO fixture_counterparties (id)
SELECT c.id FROM counterparties c
WHERE EXISTS (SELECT 1 FROM fixture_patterns p WHERE c.legal_name LIKE p.pattern);

-- The control-evidence outbox deliberately holds only one-way hashes, not an
-- onboarding foreign key. Collect the fixture lifecycle facts before deleting
-- the counterparties so their generated correlations can be removed exactly.
CREATE TEMP TABLE fixture_onboardings (id uuid, cycle_number integer) ON COMMIT DROP;
INSERT INTO fixture_onboardings (id, cycle_number)
SELECT o.id, o.cycle_number
FROM counterparty_onboardings o
WHERE o.counterparty_id IN (SELECT id FROM fixture_counterparties);

CREATE TEMP TABLE fixture_onboarding_gates (
  onboarding_id uuid,
  cycle_number integer,
  gate text,
  decision text
) ON COMMIT DROP;
INSERT INTO fixture_onboarding_gates (onboarding_id, cycle_number, gate, decision)
SELECT d.onboarding_id, d.cycle_number, d.gate::text, d.decision::text
FROM counterparty_onboarding_gate_decisions d
WHERE d.onboarding_id IN (SELECT id FROM fixture_onboardings);

CREATE TEMP TABLE fixture_onboarding_cycles (onboarding_id uuid, cycle_number integer) ON COMMIT DROP;
INSERT INTO fixture_onboarding_cycles (onboarding_id, cycle_number)
SELECT id, cycle_number FROM fixture_onboardings
UNION
SELECT onboarding_id, cycle_number FROM fixture_onboarding_gates;

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

-- Alert policies created by the operational-alert and cutover suites, plus
-- everything that references them. These were previously missed entirely: the
-- suites act as `cutover-admin-<epoch>` or `regression-alert-admin`, and neither
-- matched any pattern above, so 132 policies, 366 notification deliveries, 80
-- alerts, 20 corridor policies, and 64 cases accumulated silently across runs.
CREATE TEMP TABLE fixture_alert_policies (id uuid) ON COMMIT DROP;
INSERT INTO fixture_alert_policies (id)
SELECT p.id FROM alert_policies p
WHERE p.created_by LIKE 'cutover-admin-%'
   OR p.created_by LIKE 'regression-%'
   OR EXISTS (SELECT 1 FROM fixture_actors a WHERE p.created_by LIKE a.pattern);

-- Alerts are collected by their own source reference as well as by their
-- originating policy, so an alert whose policy was already removed by an earlier
-- partial run is still caught.
CREATE TEMP TABLE fixture_alerts (id uuid) ON COMMIT DROP;
INSERT INTO fixture_alerts (id)
SELECT a.id FROM compliance_alerts a
WHERE a.source_reference LIKE 'regression-alert-%'
   OR a.alert_policy_id IN (SELECT id FROM fixture_alert_policies)
   OR a.customer_id IN (SELECT id FROM fixture_customers)
   OR a.counterparty_id IN (SELECT id FROM fixture_counterparties);

-- Cases opened by the alert-escalation suite carry their own source-reference
-- prefix and link to no fixture customer, so they need a second collection pass.
INSERT INTO fixture_cases (id)
SELECT c.id FROM compliance_cases c
WHERE c.source_reference LIKE 'regression-alert-case-%'
  AND c.id NOT IN (SELECT id FROM fixture_cases);

CREATE TEMP TABLE fixture_corridor_policies (id uuid) ON COMMIT DROP;
INSERT INTO fixture_corridor_policies (id)
SELECT p.id FROM corridor_policies p
WHERE p.created_by LIKE 'cutover-compliance-%'
   OR p.created_by LIKE 'regression-%'
   OR p.policy_version LIKE 'cutover-%'
   OR p.policy_version LIKE 'regression-%';

-- Leaf-to-root deletion.
-- The alerting subtree is removed first: deliveries and alerts reference
-- policies, and an alert may reference the case it escalated to.
DELETE FROM control_evidence_outbox e
WHERE (
  e.event_type = 'umojaflowos.counterparty.onboarding.created.v1'
  AND EXISTS (
    SELECT 1 FROM fixture_onboardings o
    WHERE e.correlation_sha256 = encode(digest(o.id::text, 'sha256'), 'hex')
  )
) OR (
  e.event_type = 'umojaflowos.counterparty.onboarding.gate-decided.v1'
  AND EXISTS (
    SELECT 1 FROM fixture_onboarding_gates d
    WHERE e.correlation_sha256 = encode(digest(d.onboarding_id::text || ':' || d.cycle_number::text || ':' || d.gate || ':' || d.decision, 'sha256'), 'hex')
  )
) OR (
  e.event_type = 'umojaflowos.counterparty.onboarding.recertification-started.v1'
  AND EXISTS (
    SELECT 1 FROM fixture_onboarding_cycles c
    WHERE e.correlation_sha256 = encode(digest(c.onboarding_id::text || ':' || c.cycle_number::text, 'sha256'), 'hex')
  )
);

DELETE FROM counterparty_onboarding_gate_decisions
WHERE onboarding_id IN (SELECT id FROM fixture_onboardings);
DELETE FROM counterparty_onboardings
WHERE id IN (SELECT id FROM fixture_onboardings);

DELETE FROM notification_deliveries WHERE alert_policy_id IN (SELECT id FROM fixture_alert_policies);
DELETE FROM compliance_alerts WHERE id IN (SELECT id FROM fixture_alerts);
DELETE FROM compliance_alerts WHERE escalated_case_id IN (SELECT id FROM fixture_cases);

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
-- Integration connections carry no actor column, so they are reachable only
-- through their counterparty; the credential suites' counterparties are named
-- with a fixture pattern for exactly this reason.
DELETE FROM counterparty_risk_assessments WHERE counterparty_id IN (SELECT id FROM fixture_counterparties);
DELETE FROM counterparty_authorizations WHERE counterparty_id IN (SELECT id FROM fixture_counterparties);
DELETE FROM beneficiaries WHERE customer_id IN (SELECT id FROM fixture_customers);
DELETE FROM regulatory_deadlines WHERE id IN (SELECT id FROM fixture_deadlines);
DELETE FROM regulatory_reports WHERE id IN (SELECT id FROM fixture_reports);
DELETE FROM counterparty_authorizations WHERE legal_entity_id IN (SELECT id FROM fixture_entities);
DELETE FROM alert_policies WHERE id IN (SELECT id FROM fixture_alert_policies);
DELETE FROM corridor_policies WHERE id IN (SELECT id FROM fixture_corridor_policies);

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
  UNION ALL SELECT id FROM fixture_alert_policies
  UNION ALL SELECT id FROM fixture_alerts
  UNION ALL SELECT id FROM fixture_corridor_policies
);
DELETE FROM activity_events WHERE EXISTS (SELECT 1 FROM fixture_actors a WHERE activity_events.actor_subject LIKE a.pattern);

DELETE FROM customers WHERE id IN (SELECT id FROM fixture_customers);
DELETE FROM counterparties WHERE id IN (SELECT id FROM fixture_counterparties);
DELETE FROM legal_entities WHERE id IN (SELECT id FROM fixture_entities);

COMMIT;
