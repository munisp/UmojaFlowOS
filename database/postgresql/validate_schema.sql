DO $$
DECLARE
  expected_tables TEXT[] := ARRAY[
    'activity_events', 'alert_policies', 'beneficiaries', 'compliance_cases',
    'corridor_policies', 'counterparties', 'counterparty_authorizations',
    'customers', 'integration_connections', 'kyc_documents', 'legal_entities',
    'liquidity_positions', 'market_observations', 'notification_deliveries',
    'payment_legs', 'payment_orders', 'policy_decisions', 'rate_locks',
    'regulatory_deadlines', 'regulatory_reports', 'sar_str_filings',
    'scheduled_jobs', 'user_role_assignments'
  ];
BEGIN
  IF (SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY(expected_tables)) <> array_length(expected_tables, 1) THEN
    RAISE EXCEPTION 'canonical PostgreSQL table set is incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'kyc_documents' AND column_name = 'storage_key') THEN
    RAISE EXCEPTION 'kyc_documents must retain object-storage references, not bytes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sar_str_filings' AND column_name = 'submission_reference') THEN
    RAISE EXCEPTION 'sar_str_filings must distinguish workflow state from verified submission evidence';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'rate_locks_status_expiry_idx') THEN
    RAISE EXCEPTION 'rate lock expiry index is missing';
  END IF;
END $$;

SELECT 'canonical PostgreSQL schema validated' AS validation_result;
