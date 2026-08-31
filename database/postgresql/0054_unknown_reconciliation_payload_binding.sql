BEGIN;

ALTER TABLE provider_unknown_reconciliation
    ALTER COLUMN intent_id TYPE TEXT USING intent_id::text;

ALTER TABLE provider_reconciliation_decision
    ALTER COLUMN intent_id TYPE TEXT USING intent_id::text;

ALTER TABLE provider_unknown_reconciliation
    ADD COLUMN IF NOT EXISTS intent_asset TEXT,
    ADD COLUMN IF NOT EXISTS intent_fiat TEXT,
    ADD COLUMN IF NOT EXISTS intent_amount_minor BIGINT,
    ADD COLUMN IF NOT EXISTS intent_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS intent_payload JSONB,
    ADD COLUMN IF NOT EXISTS intent_digest TEXT,
    ADD COLUMN IF NOT EXISTS lease_token UUID;

-- Existing rows created by 0053 must be explicitly backfilled from trusted
-- payment-order evidence before this migration can complete. Silent defaults
-- would weaken idempotency binding and are therefore rejected.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM provider_unknown_reconciliation
         WHERE intent_payload IS NULL OR intent_digest IS NULL
    ) THEN
        RAISE EXCEPTION '0054 requires an evidence-backed payload/digest backfill for existing UNKNOWN rows';
    END IF;
END $$;

ALTER TABLE provider_unknown_reconciliation
    ALTER COLUMN intent_payload SET NOT NULL,
    ALTER COLUMN intent_digest SET NOT NULL;

ALTER TABLE provider_unknown_reconciliation
    ADD CONSTRAINT provider_unknown_reconciliation_digest_ck
    CHECK (intent_digest ~ '^[0-9a-f]{64}$');

CREATE INDEX IF NOT EXISTS provider_unknown_reconciliation_lease_idx
    ON provider_unknown_reconciliation (idempotency_key, lease_token)
    WHERE resolved_at IS NULL;

COMMIT;
