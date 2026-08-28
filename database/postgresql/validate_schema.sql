DO $$
DECLARE
  expected_tables TEXT[] := ARRAY[
    'activity_events', 'alert_policies', 'beneficiaries', 'cbn_sandbox_consumer_records', 'cbn_sandbox_dossiers', 'cbn_sandbox_evidence_assessments', 'cbn_sandbox_evidence_items', 'cbn_sandbox_incidents', 'cbn_sandbox_reporting_packs', 'cbn_sandbox_test_plans', 'compliance_cases',
    'control_evidence_outbox', 'corridor_policies', 'counterparties', 'counterparty_authorizations', 'counterparty_onboardings', 'counterparty_onboarding_gate_decisions',
    'counterparty_evidence_items', 'counterparty_financial_soundness_decisions', 'bank_evidence_items', 'counterparty_crypto_posture_decisions', 'psp_evidence_items', 'psp_gate_decisions',
    'customers', 'customer_destination_counterparties', 'customer_use_case_gate_decisions', 'integration_connections', 'kyc_documents', 'kyc_document_upload_intents', 'legal_entities',
    'liquidity_positions', 'market_observations', 'notification_deliveries',
    'payment_legs', 'payment_orders', 'policy_decisions', 'rate_locks',
    'postgres_cutover_runs', 'postgres_cutover_table_reconciliations', 'regulatory_deadlines', 'regulatory_reports', 'sar_str_filings',
    'scheduled_jobs', 'user_role_assignments', 'operator_role_assignments', 'operator_access_requests',
    'external_stakeholder_assignments', 'external_stakeholder_evidence',
    'vasp_regulatory_profiles', 'vasp_regulatory_evidence_items', 'vasp_travel_rule_evidence_items', 'vasp_travel_rule_route_assessments',
    'vasp_offshore_counterparty_profiles', 'vasp_offshore_counterparty_evidence_items', 'vasp_offshore_counterparty_assessments',
    'ledger_account_bindings', 'tigerbeetle_transfer_facts', 'aml_screening_checks', 'provider_send_requests', 'regulatory_submission_attempts', 'vasp_readiness_assurance_items', 'segregation_of_duties_evaluation_runs', 'ledger_posting_intents', 'ledger_reconciliation_runs', 'ledger_reconciliation_discrepancies'
  ];
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(expected_tables) AS expected(tablename) WHERE to_regclass('public.' || expected.tablename) IS NULL) THEN
    RAISE EXCEPTION 'canonical PostgreSQL table set is incomplete: %', (SELECT string_agg(expected.tablename, ', ' ORDER BY expected.tablename) FROM unnest(expected_tables) AS expected(tablename) WHERE to_regclass('public.' || expected.tablename) IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'kyc_documents' AND column_name = 'storage_key') THEN
    RAISE EXCEPTION 'kyc_documents must retain object-storage references, not bytes';
  END IF;
  IF to_regclass('public.kyc_document_upload_intents') IS NULL THEN
    RAISE EXCEPTION 'KYC document upload-intent metadata table is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sar_str_filings' AND column_name = 'submission_reference') THEN
    RAISE EXCEPTION 'sar_str_filings must distinguish workflow state from verified submission evidence';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'rate_locks_status_expiry_idx') THEN
    RAISE EXCEPTION 'rate lock expiry index is missing';
  END IF;
  IF to_regclass('public.verification_consents') IS NULL
     OR to_regclass('public.document_analysis_jobs') IS NULL
     OR to_regclass('public.document_analysis_evidence') IS NULL
     OR to_regclass('public.verification_reviewer_decisions') IS NULL THEN
    RAISE EXCEPTION 'canonical KYC/KYB document-intelligence tables are missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cbn_sandbox_test_plans' AND column_name='wind_down_uri')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cbn_sandbox_incidents' AND column_name='notification_status')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cbn_sandbox_reporting_packs' AND column_name='submission_reference')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cbn_sandbox_evidence_assessments' AND column_name='external_eligibility') THEN
    RAISE EXCEPTION 'CBN sandbox readiness must preserve test wind-down, internal evidence assessment, and non-assertive external evidence boundaries';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='tigerbeetle_transfer_facts' AND column_name='reconciliation_state')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='aml_screening_checks' AND column_name='evidence_sha256')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='provider_send_requests' AND column_name='finality_state')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='regulatory_submission_attempts' AND column_name='external_reference') THEN
    RAISE EXCEPTION 'live pipeline evidence tables must preserve reconciliation and externally attributable receipt boundaries';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='vasp_readiness_assurance_items' AND column_name='external_attestation_sha256')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='vasp_readiness_assurance_items' AND column_name='verified_by') THEN
    RAISE EXCEPTION 'readiness assurance items must retain external-attestation and independent-verifier evidence';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ledger_reconciliation_runs' AND column_name='status')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ledger_reconciliation_discrepancies' AND column_name='discrepancy_code') THEN
    RAISE EXCEPTION 'ledger reconciliation evidence tables must retain run status and discrepancy codes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='segregation_of_duties_evaluation_runs' AND column_name='evaluation_state')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='segregation_of_duties_evaluation_runs' AND column_name='exception_digest') THEN
    RAISE EXCEPTION 'segregation-of-duties evaluator evidence must retain state and digest';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='operator_role_assignments' AND column_name='subject')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='external_stakeholder_assignments' AND column_name='stakeholder_subject')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='external_stakeholder_evidence' AND column_name='evidence_sha256') THEN
    RAISE EXCEPTION 'external stakeholder authority must resolve through canonical PostgreSQL assignments and hashed evidence';
  END IF;
END $$;

SELECT 'canonical PostgreSQL schema validated' AS validation_result;
