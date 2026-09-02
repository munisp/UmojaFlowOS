-- Native Idem-inspired stablecoin intent and idempotency store.
-- TigerBeetle remains the monetary authority. These tables store commands,
-- durable workflow state, event deduplication, and audit projection only.

BEGIN;

CREATE TABLE IF NOT EXISTS stablecoin_intent (
    id uuid PRIMARY KEY,
    tenant_id text NOT NULL,
    idempotency_key text NOT NULL,
    payload jsonb NOT NULL,
    payload_sha256 char(64) NOT NULL
        CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
    asset text NOT NULL,
    fiat text NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    direction text NOT NULL CHECK (direction IN ('onramp', 'offramp')),
    status text NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING', 'SUBMITTED', 'SETTLED', 'HELD', 'FAILED', 'UNKNOWN')),
    provider_name text,
    provider_ref text,
    release_sha char(40) NOT NULL
        CHECK (release_sha ~ '^[a-f0-9]{40}$'),
    reconciliation_run_id text NOT NULL
        CHECK (reconciliation_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    tigerbeetle_transfer_id bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    terminal_at timestamptz,
    UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS stablecoin_idempotency_key (
    tenant_id text NOT NULL,
    idempotency_key text NOT NULL,
    intent_id uuid NOT NULL REFERENCES stablecoin_intent(id),
    payload_sha256 char(64) NOT NULL
        CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
    response jsonb,
    state text NOT NULL DEFAULT 'IN_PROGRESS'
        CHECK (state IN ('IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, idempotency_key),
    UNIQUE (intent_id),
    CONSTRAINT stablecoin_idempotency_payload_fk
        FOREIGN KEY (tenant_id, idempotency_key)
        REFERENCES stablecoin_intent (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS stablecoin_event_inbox (
    tenant_id text NOT NULL,
    event_id text NOT NULL,
    event_type text NOT NULL,
    correlation_id text NOT NULL,
    payload_sha256 char(64) NOT NULL
        CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
    reconciliation_run_id text NOT NULL
        CHECK (reconciliation_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    received_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    processing_error text,
    PRIMARY KEY (tenant_id, event_id)
);

CREATE TABLE IF NOT EXISTS stablecoin_terminal_decision (
    tenant_id text NOT NULL,
    intent_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    decision text NOT NULL CHECK (decision IN ('SETTLED', 'HELD', 'FAILED', 'UNKNOWN')),
    tigerbeetle_transfer_id bigint,
    provider_ref text,
    reconciliation_run_id text NOT NULL
        CHECK (reconciliation_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
    evidence_sha256 char(64) NOT NULL
        CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
    decided_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, intent_id),
    UNIQUE (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, idempotency_key)
        REFERENCES stablecoin_intent (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS stablecoin_intent_status_idx
    ON stablecoin_intent (tenant_id, status, updated_at);
CREATE INDEX IF NOT EXISTS stablecoin_intent_run_idx
    ON stablecoin_intent (tenant_id, reconciliation_run_id, created_at);
CREATE INDEX IF NOT EXISTS stablecoin_inbox_unprocessed_idx
    ON stablecoin_event_inbox (tenant_id, processed_at, received_at)
    WHERE processed_at IS NULL;

CREATE OR REPLACE FUNCTION stablecoin_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stablecoin_intent_updated_at ON stablecoin_intent;
CREATE TRIGGER stablecoin_intent_updated_at
BEFORE UPDATE ON stablecoin_intent FOR EACH ROW
EXECUTE FUNCTION stablecoin_set_updated_at();

DROP TRIGGER IF EXISTS stablecoin_idempotency_updated_at ON stablecoin_idempotency_key;
CREATE TRIGGER stablecoin_idempotency_updated_at
BEFORE UPDATE ON stablecoin_idempotency_key FOR EACH ROW
EXECUTE FUNCTION stablecoin_set_updated_at();

-- Tenant context is transaction-local and must be set by trusted service code:
-- SELECT set_config('app.tenant_id', $tenant_id, true);
-- Worker context additionally binds the release/reconciliation run.
CREATE OR REPLACE FUNCTION stablecoin_current_tenant()
RETURNS text LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('app.tenant_id', true), '');
$$;

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'stablecoin_intent',
        'stablecoin_idempotency_key',
        'stablecoin_event_inbox',
        'stablecoin_terminal_decision'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_tenant_isolation', table_name);
        EXECUTE format(
            'CREATE POLICY %I ON %I USING (tenant_id = stablecoin_current_tenant()) WITH CHECK (tenant_id = stablecoin_current_tenant())',
            table_name || '_tenant_isolation', table_name
        );
    END LOOP;
END $$;

-- These grants assume the deployment creates an application role and a separate
-- schema-owner role. The application role receives DML only; it must not own
-- the tables, alter RLS, or bypass retention/terminal constraints.
GRANT SELECT, INSERT, UPDATE ON stablecoin_intent TO umoja_app;
GRANT SELECT, INSERT, UPDATE ON stablecoin_idempotency_key TO umoja_app;
GRANT SELECT, INSERT, UPDATE ON stablecoin_event_inbox TO umoja_app;
GRANT SELECT, INSERT ON stablecoin_terminal_decision TO umoja_app;
GRANT USAGE ON SCHEMA public TO umoja_app;

COMMIT;
