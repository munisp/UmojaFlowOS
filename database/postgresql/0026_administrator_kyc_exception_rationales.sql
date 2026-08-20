ALTER TABLE administrator_kyc_evidence
  ADD COLUMN IF NOT EXISTS jurisdiction_exception_rationale TEXT;
ALTER TABLE administrator_kyc_evidence
  ADD CONSTRAINT administrator_kyc_evidence_jurisdiction_exception_check
  CHECK (
    (jurisdiction_code <> 'OTHER' AND jurisdiction_exception_rationale IS NULL)
    OR
    (jurisdiction_code = 'OTHER' AND char_length(trim(jurisdiction_exception_rationale)) BETWEEN 16 AND 4000)
  );
