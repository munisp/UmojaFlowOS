BEGIN;

ALTER TABLE document_analysis_jobs
  ADD COLUMN selected_model_tag TEXT,
  ADD COLUMN selected_model_digest TEXT,
  ADD COLUMN selected_model_role TEXT;

ALTER TABLE document_analysis_jobs
  ADD CONSTRAINT document_analysis_jobs_model_selection_check CHECK (
    (selected_model_tag IS NULL AND selected_model_digest IS NULL AND selected_model_role IS NULL)
    OR (
      selected_model_tag IS NOT NULL
      AND selected_model_digest ~ '^[a-f0-9]{64}$'
      AND selected_model_role IN ('visual_primary', 'text_fallback')
    )
  );

CREATE INDEX document_analysis_jobs_selected_model_idx
  ON document_analysis_jobs (selected_model_tag, selected_model_digest)
  WHERE selected_model_tag IS NOT NULL;

COMMIT;
