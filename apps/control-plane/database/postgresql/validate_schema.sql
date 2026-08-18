DO $$
BEGIN
  IF to_regclass('public.document_analysis_jobs') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_analysis_jobs' AND column_name = 'selected_model_tag')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_analysis_jobs' AND column_name = 'selected_model_digest')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_analysis_jobs' AND column_name = 'selected_model_role') THEN
    RAISE EXCEPTION 'document_analysis_jobs must preserve selected-model provenance';
  END IF;
END $$;

SELECT 'managed PostgreSQL selected-model provenance validated' AS validation_result;
