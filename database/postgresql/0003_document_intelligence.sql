-- KYC and KYB document-intelligence evidence. Apply after 0002 in a transaction-managed runner.
BEGIN;

CREATE TYPE verification_consent_scope AS ENUM ('kyc', 'kyb');
CREATE TYPE analysis_job_state AS ENUM ('queued', 'running', 'review_required', 'unavailable', 'failed');
CREATE TYPE analysis_evidence_kind AS ENUM ('ocr', 'document_structure', 'visual_consistency', 'presentation_attack_risk', 'engine_unavailable');
CREATE TYPE reviewer_disposition AS ENUM ('approved', 'rejected', 'needs_information', 'escalated');

CREATE TABLE verification_consents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope verification_consent_scope NOT NULL,
    subject_reference TEXT NOT NULL,
    consent_version TEXT NOT NULL,
    purpose TEXT NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    captured_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
    CHECK (expires_at IS NULL OR expires_at >= granted_at)
);

CREATE TABLE document_analysis_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    consent_id UUID NOT NULL REFERENCES verification_consents(id),
    kyc_document_id UUID REFERENCES kyc_documents(id),
    case_kind verification_consent_scope NOT NULL,
    document_class TEXT NOT NULL,
    source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
    source_uri TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    state analysis_job_state NOT NULL DEFAULT 'queued',
    submitted_by TEXT NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    CHECK (completed_at IS NULL OR completed_at >= submitted_at)
);

CREATE TABLE document_analysis_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_job_id UUID NOT NULL REFERENCES document_analysis_jobs(id),
    kind analysis_evidence_kind NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('review_required', 'insufficient_evidence', 'unavailable')),
    engine_name TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    model_tag TEXT,
    model_digest TEXT,
    prompt_policy_version TEXT,
    evidence_sha256 TEXT CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[a-f0-9]{64}$'),
    signals JSONB NOT NULL DEFAULT '[]'::jsonb,
    limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE verification_reviewer_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    analysis_job_id UUID NOT NULL REFERENCES document_analysis_jobs(id),
    disposition reviewer_disposition NOT NULL,
    rationale TEXT NOT NULL,
    decided_by TEXT NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (analysis_job_id)
);

CREATE INDEX document_analysis_jobs_state_idx ON document_analysis_jobs (state, submitted_at DESC);
CREATE INDEX document_analysis_jobs_consent_idx ON document_analysis_jobs (consent_id, submitted_at DESC);
CREATE INDEX document_analysis_evidence_job_idx ON document_analysis_evidence (analysis_job_id, created_at DESC);
CREATE INDEX verification_reviewer_decisions_job_idx ON verification_reviewer_decisions (analysis_job_id, decided_at DESC);

COMMIT;
