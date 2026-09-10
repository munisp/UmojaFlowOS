BEGIN;

CREATE TABLE IF NOT EXISTS settlement_fence_state (
    environment       text PRIMARY KEY
                       CHECK (environment ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
    fenced            boolean NOT NULL DEFAULT true,
    fence_version     bigint NOT NULL DEFAULT 0 CHECK (fence_version >= 0),
    reason            text NOT NULL DEFAULT 'startup fail-closed fence'
                       CHECK (length(reason) BETWEEN 1 AND 512),
    command_id        text,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT settlement_fence_state_command_fk
        FOREIGN KEY (command_id) REFERENCES settlement_fence_commands(command_id)
);

CREATE INDEX IF NOT EXISTS settlement_fence_state_updated_idx
    ON settlement_fence_state (updated_at);

REVOKE ALL ON settlement_fence_state FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON settlement_fence_state TO umoja_app;

COMMIT;
