-- Independently authorised, single-use resolution for UNKNOWN settlement sagas.
-- The payment-engine application role may consume an already verified approval,
-- but does not receive INSERT/DELETE rights on this evidence table.
BEGIN;

ALTER TABLE settlement_saga
    ADD COLUMN IF NOT EXISTS resolution_lease_owner text,
    ADD COLUMN IF NOT EXISTS resolution_leased_until timestamptz,
    ADD COLUMN IF NOT EXISTS reconciliation_attempt_count integer NOT NULL DEFAULT 0
        CHECK (reconciliation_attempt_count >= 0);

CREATE TABLE IF NOT EXISTS settlement_unknown_resolution_authorization (
    tenant_id text NOT NULL,
    saga_id text NOT NULL,
    authorization_id text NOT NULL,
    decision text NOT NULL CHECK (decision IN ('commit', 'void', 'hold')),
    release_sha char(40) NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
    manifest_sha256 char(64) NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
    reconciliation_run_id text NOT NULL CHECK (length(reconciliation_run_id) >= 8),
    evidence_sha256 char(64) NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
    issued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > issued_at),
    verified_at timestamptz NOT NULL,
    consumed_at timestamptz,
    consumed_by text,
    PRIMARY KEY (tenant_id, saga_id, authorization_id),
    FOREIGN KEY (tenant_id, saga_id) REFERENCES settlement_saga (tenant_id, saga_id),
    CHECK ((consumed_at IS NULL AND consumed_by IS NULL) OR (consumed_at IS NOT NULL AND consumed_by IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS settlement_unknown_resolution_one_active_idx
    ON settlement_unknown_resolution_authorization (tenant_id, saga_id)
    WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS settlement_saga_unknown_claim_idx
    ON settlement_saga (tenant_id, updated_at)
    WHERE stage = 'unknown';

ALTER TABLE settlement_unknown_resolution_authorization ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_unknown_resolution_authorization FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS settlement_unknown_resolution_authorization_tenant_isolation ON settlement_unknown_resolution_authorization;
CREATE POLICY settlement_unknown_resolution_authorization_tenant_isolation
    ON settlement_unknown_resolution_authorization
    USING (tenant_id = settlement_saga_current_tenant())
    WITH CHECK (tenant_id = settlement_saga_current_tenant());

COMMIT;
