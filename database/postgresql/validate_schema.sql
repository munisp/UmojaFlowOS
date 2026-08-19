DO $$
DECLARE
  expected_tables TEXT[] := ARRAY[
    'activity_events', 'alert_policies', 'beneficiaries', 'cbn_sandbox_consumer_records', 'cbn_sandbox_dossiers', 'cbn_sandbox_evidence_items', 'cbn_sandbox_incidents', 'cbn_sandbox_reporting_packs', 'cbn_sandbox_test_plans', 'compliance_cases',
    'control_evidence_outbox', 'corridor_policies', 'counterparties', 'counterparty_authorizations', 'counterparty_onboardings', 'counterparty_onboarding_gate_decisions',
    'customers', 'integration_connections', 'kyc_documents', 'kyc_document_upload_intents', 'legal_entities',
    'liquidity_positions', 'market_observations', 'notification_deliveries',
    'payment_legs', 'payment_orders', 'policy_decisions', 'rate_locks',
    'postgres_cutover_runs', 'postgres_cutover_table_reconciliations', 'regulatory_deadlines', 'regulatory_reports', 'sar_str_filings',
    'scheduled_jobs', 'user_role_assignments'
  ];
BEGIN
  IF (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY(expected_tables)) <> array_length(expected_tables, 1) THEN
    RAISE EXCEPTION 'canonical PostgreSQL table set is incomplete';
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
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cbn_sandbox_reporting_packs' AND column_name='submission_reference') THEN
    RAISE EXCEPTION 'CBN sandbox readiness must preserve test wind-down and non-assertive notification/submission evidence';
  END IF;
END $$;

SELECT 'canonical PostgreSQL schema validated' AS validation_result;
