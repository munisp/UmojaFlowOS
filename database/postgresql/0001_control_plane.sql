CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE operating_role AS ENUM ('admin', 'compliance_officer', 'treasury_operator', 'auditor');
CREATE TYPE corridor_code AS ENUM ('NIGERIA_NGN', 'KENYA_KES', 'SOUTH_AFRICA_ZAR');
CREATE TYPE authorization_status AS ENUM ('pending_review', 'verified', 'expired', 'suspended', 'rejected');
CREATE TYPE payment_status AS ENUM ('draft', 'pending_policy_decision', 'blocked', 'manual_review', 'approved', 'executing', 'partially_completed', 'completed', 'failed', 'cancelled');
CREATE TYPE screening_state AS ENUM ('not_run', 'clear', 'potential_match', 'confirmed_match', 'source_unavailable');
CREATE TYPE case_status AS ENUM ('open', 'under_review', 'cleared', 'escalated', 'reported', 'closed');
CREATE TYPE report_status AS ENUM ('draft', 'validated', 'pending_submission', 'submitted', 'rejected', 'submission_unavailable');
CREATE TYPE integration_state AS ENUM ('unconfigured', 'credential_pending', 'verification_pending', 'active', 'suspended', 'failed');

CREATE TABLE legal_entities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_name TEXT NOT NULL,
    jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('Nigeria', 'Kenya', 'South Africa')),
    registration_identifier TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (jurisdiction, registration_identifier)
);

CREATE TABLE user_role_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_subject TEXT NOT NULL,
    role operating_role NOT NULL,
    assigned_by TEXT NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    UNIQUE (user_subject, role, revoked_at)
);

CREATE TABLE corridor_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    corridor corridor_code NOT NULL,
    regulator TEXT NOT NULL CHECK (regulator IN ('CBN', 'CBK', 'SARB')),
    policy_version TEXT NOT NULL,
    effective_from TIMESTAMPTZ NOT NULL,
    effective_to TIMESTAMPTZ,
    requires_travel_rule BOOLEAN NOT NULL DEFAULT FALSE,
    requires_authorised_fx_intermediary BOOLEAN NOT NULL DEFAULT TRUE,
    activation_status authorization_status NOT NULL DEFAULT 'pending_review',
    policy_document_uri TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (corridor, policy_version)
);

CREATE TABLE counterparties (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_name TEXT NOT NULL,
    counterparty_type TEXT NOT NULL CHECK (counterparty_type IN ('licensed_psp', 'correspondent_bank', 'stablecoin_provider', 'fx_liquidity_provider', 'custody_provider', 'kyc_provider', 'sanctions_provider', 'notification_provider', 'regulatory_submission_provider')),
    jurisdiction TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (legal_name, counterparty_type, jurisdiction)
);

CREATE TABLE counterparty_authorizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    counterparty_id UUID NOT NULL REFERENCES counterparties(id),
    legal_entity_id UUID REFERENCES legal_entities(id),
    regulator TEXT NOT NULL,
    licence_reference TEXT NOT NULL,
    scope_description TEXT NOT NULL,
    evidence_uri TEXT NOT NULL,
    valid_from DATE NOT NULL,
    valid_to DATE,
    status authorization_status NOT NULL DEFAULT 'pending_review',
    verified_by TEXT,
    verified_at TIMESTAMPTZ,
    UNIQUE (counterparty_id, regulator, licence_reference)
);

CREATE TABLE integration_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    counterparty_id UUID NOT NULL REFERENCES counterparties(id),
    category TEXT NOT NULL CHECK (category IN ('payment_rail', 'fx_rate', 'stablecoin_market_data', 'kyc_kyb', 'sanctions', 'chain_analytics', 'notification', 'regulatory_submission')),
    environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
    documentation_url TEXT NOT NULL,
    secret_reference TEXT,
    state integration_state NOT NULL DEFAULT 'unconfigured',
    last_health_checked_at TIMESTAMPTZ,
    last_health_result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (counterparty_id, category, environment)
);

CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_name TEXT NOT NULL,
    registration_identifier TEXT NOT NULL,
    kyc_status case_status NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (legal_name, registration_identifier)
);

CREATE TABLE beneficiaries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id),
    legal_name TEXT NOT NULL,
    country_code CHAR(2) NOT NULL,
    bank_or_wallet_reference TEXT NOT NULL,
    screening_state screening_state NOT NULL DEFAULT 'not_run',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (customer_id, legal_name, bank_or_wallet_reference)
);

CREATE TABLE liquidity_positions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    corridor corridor_code NOT NULL,
    currency TEXT NOT NULL CHECK (currency IN ('NGN', 'KES', 'ZAR', 'USD', 'USDC', 'USDT')),
    account_kind TEXT NOT NULL CHECK (account_kind IN ('liquidity_pool', 'nostro', 'vostro', 'prefunding', 'custody_wallet')),
    account_reference TEXT NOT NULL,
    available_amount NUMERIC(30, 12) NOT NULL,
    reserved_amount NUMERIC(30, 12) NOT NULL DEFAULT 0,
    source_reference TEXT NOT NULL,
    reconciled_at TIMESTAMPTZ NOT NULL,
    recorded_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (available_amount >= 0),
    CHECK (reserved_amount >= 0)
);

CREATE TABLE market_observations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    integration_connection_id UUID NOT NULL REFERENCES integration_connections(id),
    base_asset TEXT NOT NULL CHECK (base_asset IN ('NGN', 'KES', 'ZAR', 'USD', 'USDC', 'USDT')),
    quote_asset TEXT NOT NULL CHECK (quote_asset IN ('NGN', 'KES', 'ZAR', 'USD', 'USDC', 'USDT')),
    rate NUMERIC(30, 12) NOT NULL CHECK (rate > 0),
    observed_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_reference TEXT NOT NULL,
    CHECK (base_asset <> quote_asset)
);

CREATE TABLE payment_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT NOT NULL UNIQUE,
    customer_id UUID NOT NULL REFERENCES customers(id),
    beneficiary_id UUID NOT NULL REFERENCES beneficiaries(id),
    corridor corridor_code NOT NULL,
    source_currency TEXT NOT NULL CHECK (source_currency IN ('NGN', 'KES', 'ZAR', 'USD', 'USDC', 'USDT')),
    source_amount NUMERIC(30, 12) NOT NULL CHECK (source_amount > 0),
    target_currency TEXT NOT NULL CHECK (target_currency IN ('NGN', 'KES', 'ZAR', 'USD', 'USDC', 'USDT')),
    target_amount NUMERIC(30, 12),
    status payment_status NOT NULL DEFAULT 'draft',
    policy_decision_id UUID,
    provider_finality_reference TEXT,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payment_legs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_order_id UUID NOT NULL REFERENCES payment_orders(id),
    sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
    leg_kind TEXT NOT NULL CHECK (leg_kind IN ('collection', 'fx', 'stablecoin_settlement', 'payout', 'reversal')),
    counterparty_id UUID REFERENCES counterparties(id),
    status payment_status NOT NULL DEFAULT 'draft',
    provider_instruction_reference TEXT,
    provider_finality_reference TEXT,
    UNIQUE (payment_order_id, sequence_number)
);

CREATE TABLE policy_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_order_id UUID NOT NULL REFERENCES payment_orders(id),
    policy_id UUID NOT NULL REFERENCES corridor_policies(id),
    decision TEXT NOT NULL CHECK (decision IN ('allow', 'manual_review', 'block')),
    reason_codes TEXT[] NOT NULL DEFAULT '{}',
    evidence JSONB NOT NULL,
    decision_hash TEXT NOT NULL,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (payment_order_id, policy_id, decision_hash)
);

ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_policy_decision_fk FOREIGN KEY (policy_decision_id) REFERENCES policy_decisions(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE compliance_cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_order_id UUID REFERENCES payment_orders(id),
    customer_id UUID REFERENCES customers(id),
    case_type TEXT NOT NULL CHECK (case_type IN ('kyc', 'sanctions', 'transaction_monitoring', 'travel_rule', 'counterparty', 'sar_str')),
    status case_status NOT NULL DEFAULT 'open',
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    source_reference TEXT NOT NULL,
    decision_reason TEXT,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ
);

CREATE TABLE regulatory_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    regulator TEXT NOT NULL CHECK (regulator IN ('CBN', 'CBK', 'SARB')),
    corridor corridor_code NOT NULL,
    report_type TEXT NOT NULL,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    legal_entity_id UUID NOT NULL REFERENCES legal_entities(id),
    status report_status NOT NULL DEFAULT 'draft',
    artifact_uri TEXT,
    evidence_manifest JSONB,
    submission_reference TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (period_end >= period_start)
);

CREATE TABLE alert_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_type TEXT NOT NULL CHECK (alert_type IN ('liquidity_threshold', 'payment_failure', 'compliance_flag', 'regulatory_deadline')),
    corridor corridor_code,
    threshold JSONB NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE activity_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_subject TEXT NOT NULL,
    actor_role operating_role NOT NULL,
    action TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id UUID,
    correlation_id UUID NOT NULL DEFAULT gen_random_uuid(),
    before_hash TEXT,
    after_hash TEXT,
    policy_version TEXT,
    source_ip INET,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX activity_events_object_idx ON activity_events (object_type, object_id, occurred_at DESC);
CREATE INDEX payment_orders_corridor_status_idx ON payment_orders (corridor, status, created_at DESC);
CREATE INDEX compliance_cases_status_idx ON compliance_cases (status, severity, opened_at DESC);
CREATE INDEX market_observations_pair_idx ON market_observations (base_asset, quote_asset, observed_at DESC);
