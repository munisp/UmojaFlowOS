BEGIN;

CREATE SEQUENCE IF NOT EXISTS settlement_fence_command_version_seq;

CREATE TABLE IF NOT EXISTS settlement_fence_commands (
    command_id       text PRIMARY KEY,
    command_hash     text NOT NULL CHECK (command_hash ~ '^[0-9a-f]{64}$'),
    action           text NOT NULL CHECK (action IN ('FENCE', 'OPEN')),
    reason           text NOT NULL CHECK (length(reason) BETWEEN 1 AND 512),
    environment      text NOT NULL CHECK (environment ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
    source_alerts    jsonb NOT NULL CHECK (jsonb_typeof(source_alerts) = 'array'),
    issued_at        timestamptz NOT NULL,
    expires_at       timestamptz NOT NULL,
    nonce            text NOT NULL,
    signer           text NOT NULL,
    applied_at       timestamptz NOT NULL DEFAULT now(),
    fence_version    bigint NOT NULL DEFAULT nextval('settlement_fence_command_version_seq'),
    audit_hash       text NOT NULL CHECK (audit_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT settlement_fence_valid_window CHECK (expires_at > issued_at),
    CONSTRAINT settlement_fence_command_id_nonempty CHECK (length(command_id) BETWEEN 8 AND 128),
    CONSTRAINT settlement_fence_nonce_nonempty CHECK (length(nonce) BETWEEN 16 AND 128),
    CONSTRAINT settlement_fence_source_alerts_nonempty CHECK (jsonb_array_length(source_alerts) > 0)
);

CREATE INDEX IF NOT EXISTS settlement_fence_commands_expiry_idx
    ON settlement_fence_commands (expires_at);

CREATE INDEX IF NOT EXISTS settlement_fence_commands_environment_idx
    ON settlement_fence_commands (environment, applied_at DESC);

REVOKE ALL ON settlement_fence_commands FROM PUBLIC;
GRANT SELECT, INSERT ON settlement_fence_commands TO umoja_app;
GRANT USAGE, SELECT ON SEQUENCE settlement_fence_command_version_seq TO umoja_app;

COMMENT ON TABLE settlement_fence_commands IS
    'Append-only signed settlement-fence commands. command_id is the durable replay key.';
COMMENT ON COLUMN settlement_fence_commands.command_hash IS
    'SHA-256 of the canonical command with signature field empty.';
COMMENT ON COLUMN settlement_fence_commands.audit_hash IS
    'SHA-256 digest recorded by the immutable audit sink.';

COMMIT;
