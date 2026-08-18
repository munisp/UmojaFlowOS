-- PostgreSQL-only continuation of the canonical control-plane schema.
-- Apply after 0001_control_plane.sql in a transaction-managed migration runner.

BEGIN;

ALTER TABLE counterparties DROP CONSTRAINT IF EXISTS counterparties_counterparty_type_check;
ALTER TABLE counterparties ADD CONSTRAINT counterparties_counterparty_type_check CHECK (counterparty_type IN ('licensed_psp', 'correspondent_bank', 'stablecoin_provider', 'fx_liquidity_provider', 'custody_provider', 'kyc_provider', 'sanctions_provider', 'chain_analytics_provider', 'notification_provider', 'regulatory_submission_provider'));

CREATE TYPE rate_lock_status AS ENUM ('locked', 'expired', 'cancelled');
CREATE TYPE kyc_document_type AS ENUM ('registration_certificate', 'identity_document', 'proof_of_address', 'beneficial_ownership', 'source_of_funds', 'other');
CREATE TYPE kyc_review_status AS ENUM ('submitted', 'under_review', 'approved', 'rejected', 'expired');
CREATE TYPE sar_str_filing_type AS ENUM ('sar', 'str');
CREATE TYPE sar_str_filing_status AS ENUM ('draft', 'under_review', 'approved_for_submission', 'pending_submission', 'submitted', 'submission_unavailable', 'rejected');
CREATE TYPE regulatory_deadline_status AS ENUM ('open', 'acknowledged', 'completed', 'cancelled');
CREATE TYPE notification_delivery_state AS ENUM ('accepted', 'unavailable');
CREATE TYPE scheduled_job_purpose AS ENUM ('regulatory_deadline_reminders');

CREATE TABLE kyc_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id),
    document_type kyc_document_type NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    storage_url TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    review_status kyc_review_status NOT NULL DEFAULT 'submitted',
    review_note TEXT,
    reviewed_by TEXT,
    reviewed_at TIMESTAMPTZ,
    uploaded_by TEXT NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rate_locks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_observation_id UUID NOT NULL REFERENCES market_observations(id),
    payment_order_id UUID REFERENCES payment_orders(id),
    corridor corridor_code NOT NULL,
    base_asset TEXT NOT NULL CHECK (base_asset IN ('NGN', 'KES', 'ZAR', 'USD', 'USDC', 'USDT')),
    quote_asset TEXT NOT NULL CHECK (quote_asset IN ('NGN', 'KES', 'ZAR', 'USD', 'USDC', 'USDT')),
    locked_rate NUMERIC(30, 12) NOT NULL CHECK (locked_rate > 0),
    status rate_lock_status NOT NULL DEFAULT 'locked',
    expires_at TIMESTAMPTZ NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (base_asset <> quote_asset)
);

CREATE TABLE sar_str_filings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    compliance_case_id UUID NOT NULL REFERENCES compliance_cases(id),
    corridor corridor_code NOT NULL,
    filing_type sar_str_filing_type NOT NULL,
    filing_authority TEXT NOT NULL,
    source_reference TEXT NOT NULL,
    status sar_str_filing_status NOT NULL DEFAULT 'draft',
    submission_reference TEXT,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE regulatory_deadlines (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    regulator TEXT NOT NULL CHECK (regulator IN ('CBN', 'CBK', 'SARB')),
    corridor corridor_code NOT NULL,
    title TEXT NOT NULL,
    due_at TIMESTAMPTZ NOT NULL,
    source_reference TEXT NOT NULL,
    status regulatory_deadline_status NOT NULL DEFAULT 'open',
    last_reminded_at TIMESTAMPTZ,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notification_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_policy_id UUID REFERENCES alert_policies(id),
    alert_type TEXT NOT NULL CHECK (alert_type IN ('liquidity_threshold', 'payment_failure', 'compliance_flag', 'regulatory_deadline')),
    delivery_state notification_delivery_state NOT NULL,
    destination TEXT NOT NULL,
    correlation_id UUID NOT NULL,
    payload_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scheduled_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purpose scheduled_job_purpose NOT NULL UNIQUE,
    schedule_cron_task_uid TEXT UNIQUE,
    cron_expression TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    last_executed_at TIMESTAMPTZ,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX kyc_documents_customer_idx ON kyc_documents (customer_id, review_status, uploaded_at DESC);
CREATE INDEX rate_locks_status_expiry_idx ON rate_locks (status, expires_at);
CREATE INDEX sar_str_filings_status_idx ON sar_str_filings (corridor, status, created_at DESC);
CREATE INDEX regulatory_deadlines_due_idx ON regulatory_deadlines (status, due_at);
CREATE INDEX notification_deliveries_alert_idx ON notification_deliveries (alert_type, created_at DESC);
CREATE INDEX scheduled_jobs_task_idx ON scheduled_jobs (schedule_cron_task_uid);

COMMIT;
