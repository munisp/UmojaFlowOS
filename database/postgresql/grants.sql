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
SELECT current_database() AS target_database_name \gset

BEGIN;

GRANT CONNECT ON DATABASE :"target_database_name" TO :"app_role_ident";
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
  counterparty_onboarding_gate_decisions,
  market_observations,
  service_health_samples,
  cbn_sandbox_evidence_items,
  cbn_sandbox_consumer_records,
  cbn_sandbox_incidents,
  cbn_sandbox_reporting_packs,
  cbn_sandbox_evidence_assessments,
  vasp_regulatory_evidence_items,
  vasp_travel_rule_evidence_items,
  vasp_travel_rule_route_assessments,
  vasp_offshore_counterparty_assessments,
  user_role_assignments,
  external_stakeholder_evidence,
  ledger_account_bindings,
  tigerbeetle_transfer_facts,
  aml_screening_checks,
  regulatory_submission_attempts,
  segregation_of_duties_evaluation_runs,
  ledger_posting_intents,
  ledger_reconciliation_runs,
  ledger_reconciliation_discrepancies,
  customer_destination_counterparties,
  customer_use_case_gate_decisions,
  counterparty_evidence_items,
  counterparty_financial_soundness_decisions,
  bank_evidence_items,
  counterparty_crypto_posture_decisions,
  psp_evidence_items,
  psp_gate_decisions,
  stablecoin_issuer_evidence_items,
  stablecoin_issuer_gate_decisions,
  compliance_vendor_evidence_items,
  compliance_vendor_gate_decisions
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
  counterparty_onboardings,
  liquidity_positions,
  treasury_buffer_policies,
  corridor_policies,
  alert_policies,
  integration_connections,
  legal_entities,
  control_evidence_outbox,
  cbn_sandbox_dossiers,
  cbn_sandbox_test_plans,
  vasp_regulatory_profiles,
  vasp_offshore_counterparty_profiles,
  vasp_offshore_counterparty_evidence_items,
  payment_orders,
  payment_legs,
  rate_locks,
  scheduled_jobs,
  treasury_rebalancing_recommendations,
  compliance_alerts,
  operator_role_assignments,
  external_stakeholder_assignments,
  provider_send_requests,
  vasp_readiness_assurance_items,
  operator_access_requests
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
