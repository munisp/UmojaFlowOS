-- Durable, tenant-isolated settlement saga, transactional outbox, and inbox.
-- PostgreSQL is the control-plane authority; TigerBeetle is the monetary ledger.
-- This migration is deliberately forward-only and fail-closed: every settlement
-- side effect must first be tied to a tenant-scoped immutable intent binding.

BEGIN;

CREATE TABLE IF NOT EXISTS settlement_saga (
    tenant_id text NOT NULL,
    saga_id text NOT NULL,
    intent_id text NOT NULL,
    idempotency_key text NOT NULL,
    payload_sha256 char(64) NOT NULL
        CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
    direction text NOT NULL CHECK (direction IN ('onramp', 'offramp')),
    asset text NOT NULL,
    fiat text NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor > 0),
    destination text NOT NULL,
    stage text NOT NULL CHECK (stage IN (
        'received', 'screened', 'routed', 'liquidity_reserved',
        'ledger_prepared', 'fiat_submitted', 'custody_submitted',
        'finality_confirmed', 'ledger_committed', 'attestation_verified',
        'settled', 'held', 'unknown'
    )),
    route_id text,
    provider_reference text,
    custody_reference text,
    blockchain_tx text,
    ledger_pending_id bigint,
    ledger_transfer_id bigint,
    attestation_id text,
    failure_class text,
    reconciliation_run_id text,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    terminal_at timestamptz,
    PRIMARY KEY (tenant_id, saga_id),
    UNIQUE (tenant_id, intent_id),
    UNIQUE (tenant_id, idempotency_key),
    UNIQUE NULLS NOT DISTINCT (tenant_id, ledger_pending_id),
    UNIQUE NULLS NOT DISTINCT (tenant_id, ledger_transfer_id),
    CHECK (
        (stage IN ('settled', 'held', 'unknown') AND terminal_at IS NOT NULL)
        OR (stage NOT IN ('settled', 'held', 'unknown') AND terminal_at IS NULL)
    )
);

-- Settlement account bindings are owned by the schema-governed control plane.
-- External payment requests never supply TigerBeetle account IDs.
CREATE TABLE IF NOT EXISTS settlement_account_binding (
    tenant_id text NOT NULL,
    binding_id text NOT NULL,
    direction text NOT NULL CHECK (direction IN ('onramp', 'offramp')),
    asset text NOT NULL,
    fiat text NOT NULL,
    corridor_id text NOT NULL DEFAULT '',
    debit_account_id bigint NOT NULL CHECK (debit_account_id > 0),
    credit_account_id bigint NOT NULL CHECK (credit_account_id > 0),
    active boolean NOT NULL DEFAULT true,
    evidence_sha256 char(64) NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, binding_id),
    UNIQUE (tenant_id, direction, asset, fiat, corridor_id),
    CHECK (debit_account_id <> credit_account_id)
);

-- Each transition is immutable evidence. It is append-only for the application role.
CREATE TABLE IF NOT EXISTS settlement_saga_transition (
    tenant_id text NOT NULL,
    saga_id text NOT NULL,
    version bigint NOT NULL CHECK (version > 0),
    from_stage text,
    to_stage text NOT NULL,
    reason text,
    payload_sha256 char(64) NOT NULL
        CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, saga_id, version),
    FOREIGN KEY (tenant_id, saga_id)
        REFERENCES settlement_saga (tenant_id, saga_id)
);

-- The outbox is written in the same transaction as the saga state transition.
-- Consumers lease rows with FOR UPDATE SKIP LOCKED and must not publish a row
-- whose tenant-scoped saga does not still exist.
CREATE TABLE IF NOT EXISTS settlement_outbox (
    tenant_id text NOT NULL,
    event_id text NOT NULL,
    saga_id text NOT NULL,
    stage text NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    payload_sha256 char(64) NOT NULL
        CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
    reconciliation_run_id text,
    available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    leased_until timestamptz,
    lease_owner text,
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, event_id),
    UNIQUE (tenant_id, saga_id, stage),
    FOREIGN KEY (tenant_id, saga_id)
        REFERENCES settlement_saga (tenant_id, saga_id)
);

-- Inbox deduplication is separate from Kafka/Temporal broker acknowledgement.
-- A redelivered message has the same tenant/source/message tuple and cannot
-- cause a second state transition or second financial side effect.
CREATE TABLE IF NOT EXISTS settlement_inbox (
    tenant_id text NOT NULL,
    source text NOT NULL,
    message_id text NOT NULL,
    saga_id text,
    payload_sha256 char(64) NOT NULL
        CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    processed_at timestamptz,
    processing_error text,
    PRIMARY KEY (tenant_id, source, message_id),
    FOREIGN KEY (tenant_id, saga_id)
        REFERENCES settlement_saga (tenant_id, saga_id)
);

CREATE INDEX IF NOT EXISTS settlement_account_binding_lookup_idx
    ON settlement_account_binding (tenant_id, direction, asset, fiat, corridor_id)
    WHERE active;
CREATE INDEX IF NOT EXISTS settlement_saga_stage_idx
    ON settlement_saga (tenant_id, stage, updated_at);
CREATE INDEX IF NOT EXISTS settlement_outbox_available_idx
    ON settlement_outbox (available_at, created_at)
    WHERE published_at IS NULL;
CREATE INDEX IF NOT EXISTS settlement_inbox_pending_idx
    ON settlement_inbox (tenant_id, received_at)
    WHERE processed_at IS NULL;

CREATE OR REPLACE FUNCTION settlement_saga_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS settlement_saga_updated_at ON settlement_saga;
CREATE TRIGGER settlement_saga_updated_at
BEFORE UPDATE ON settlement_saga
FOR EACH ROW EXECUTE FUNCTION settlement_saga_set_updated_at();

CREATE OR REPLACE FUNCTION settlement_saga_current_tenant()
RETURNS text LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('umoja.tenant_id', true), '');
$$;

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'settlement_saga',
        'settlement_account_binding',
        'settlement_saga_transition',
        'settlement_outbox',
        'settlement_inbox'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_tenant_isolation', table_name);
        EXECUTE format(
            'CREATE POLICY %I ON %I USING (tenant_id = settlement_saga_current_tenant()) WITH CHECK (tenant_id = settlement_saga_current_tenant())',
            table_name || '_tenant_isolation', table_name
        );
    END LOOP;
END $$;

COMMIT;
