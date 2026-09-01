BEGIN;

CREATE TABLE IF NOT EXISTS fabric_attestation_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT NOT NULL UNIQUE,
    release_sha TEXT NOT NULL CHECK (release_sha ~ '^[a-f0-9]{40}$'),
    evidence_id TEXT NOT NULL,
    evidence_uri TEXT NOT NULL,
    payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
    endorsement_scope TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','running','unknown','complete')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_token UUID,
    lease_until TIMESTAMPTZ,
    attestation_id TEXT,
    last_error TEXT,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((state = 'complete') = (attestation_id IS NOT NULL)),
    CHECK (state <> 'complete' OR completed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS fabric_attestation_queue_due_idx
    ON fabric_attestation_queue (next_attempt_at, created_at)
    WHERE state IN ('pending','unknown');

CREATE INDEX IF NOT EXISTS fabric_attestation_queue_expired_lease_idx
    ON fabric_attestation_queue (lease_until, created_at)
    WHERE state = 'running';

CREATE UNIQUE INDEX IF NOT EXISTS fabric_attestation_queue_attestation_once_idx
    ON fabric_attestation_queue (attestation_id)
    WHERE attestation_id IS NOT NULL;

COMMIT;
