DO $$
BEGIN
  IF to_regclass('public.document_analysis_jobs') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_analysis_jobs' AND column_name = 'selected_model_tag')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_analysis_jobs' AND column_name = 'selected_model_digest')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_analysis_jobs' AND column_name = 'selected_model_role') THEN
    RAISE EXCEPTION 'document_analysis_jobs must preserve selected-model provenance';
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.cbn_sandbox_dossiers') IS NULL
     OR to_regclass('public.cbn_sandbox_evidence_items') IS NULL
     OR to_regclass('public.cbn_sandbox_test_plans') IS NULL
     OR to_regclass('public.cbn_sandbox_consumer_records') IS NULL
     OR to_regclass('public.cbn_sandbox_incidents') IS NULL
     OR to_regclass('public.cbn_sandbox_reporting_packs') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cbn_sandbox_test_plans' AND column_name='wind_down_uri')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='cbn_sandbox_incidents' AND column_name='notification_status') THEN
    RAISE EXCEPTION 'CBN sandbox dossier, controlled-test, consumer, incident, and reporting boundaries are incomplete';
  END IF;
END $$;

SELECT 'managed PostgreSQL selected-model provenance validated' AS validation_result;
