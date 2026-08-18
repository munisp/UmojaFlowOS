-- Canonical PostgreSQL application-role privileges for UmojaFlowOS.
--
-- The application role never owns schema objects and never receives DDL rights,
-- so schema evolution stays restricted to reviewed forward-only migrations run
-- by the schema owner. The role receives only the data-manipulation privileges
-- the control plane actually exercises. Immutable evidence tables are
-- append-only for the application role: no UPDATE and no DELETE is granted, so
-- audit and evidence history cannot be rewritten or erased through the
-- application connection.
--
-- Usage (schema owner):
--   psql -v app_role=<role> -d umojaflowos_dev -f database/postgresql/grants.sql

\set app_role_ident :app_role

BEGIN;

GRANT CONNECT ON DATABASE umojaflowos_dev TO :"app_role_ident";
GRANT USAGE ON SCHEMA public TO :"app_role_ident";

-- Read access across the canonical schema for auditor-visible ledgers.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO :"app_role_ident";

-- Append-only immutable evidence and audit trails.
GRANT INSERT ON TABLE
  activity_events,
  document_analysis_evidence,
  policy_decisions,
  postgres_cutover_runs,
  postgres_cutover_table_reconciliations,
  notification_deliveries,
  verification_consents,
  verification_reviewer_decisions,
  counterparty_risk_assessments,
  market_observations,
  user_role_assignments
TO :"app_role_ident";

-- Records with a governed, reviewable lifecycle require in-place transitions.
GRANT INSERT, UPDATE ON TABLE
  document_analysis_jobs,
  kyc_documents,
  kyc_document_upload_intents,
  compliance_cases,
  sar_str_filings,
  regulatory_reports,
  regulatory_deadlines,
  customers,
  beneficiaries,
  counterparties,
  counterparty_authorizations,
  liquidity_positions,
  treasury_buffer_policies,
  corridor_policies,
  alert_policies,
  integration_connections,
  legal_entities,
  payment_orders,
  payment_legs,
  rate_locks,
  scheduled_jobs,
  treasury_rebalancing_recommendations
TO :"app_role_ident";

-- `treasury_stress_test_runs` is intentionally omitted: no application write
-- path exists, and stress-test execution remains fail-closed until reconciled
-- treasury inputs are available through an authorised source.

-- Serialising the consent check in the analysis-job workflow uses
-- `SELECT ... FOR UPDATE`, which PostgreSQL treats as a row-locking read and
-- therefore requires an explicit lock privilege. The grant is column scoped to
-- `revoked_at`, the single legitimate consent state change (withdrawal). Every
-- other consent column, including scope, subject reference, purpose and
-- captured-by provenance, remains immutable.
GRANT UPDATE (revoked_at) ON TABLE verification_consents TO :"app_role_ident";

COMMIT;
