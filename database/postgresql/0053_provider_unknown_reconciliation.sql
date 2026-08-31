BEGIN;

CREATE TABLE IF NOT EXISTS provider_unknown_reconciliation (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT NOT NULL UNIQUE,
    intent_id UUID NOT NULL,
    primary_rail TEXT NOT NULL,
    provider_reference TEXT,
    observed_status TEXT NOT NULL CHECK (observed_status IN ('unknown','submitted','pending','settled','failed','held')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL,
    lease_until TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS provider_unknown_reconciliation_due_idx
    ON provider_unknown_reconciliation (next_attempt_at, lease_until)
    WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS provider_reconciliation_decision (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    idempotency_key TEXT NOT NULL,
    intent_id UUID NOT NULL,
    primary_rail TEXT NOT NULL,
    provider_reference TEXT,
    decision TEXT NOT NULL CHECK (decision IN (
        'provider_accepted_no_settlement_authority',
        'confirmed_non_submission',
        'awaiting_provider_evidence',
        'quarantined_reconciliation_failure'
    )),
    observed_status TEXT NOT NULL CHECK (observed_status IN ('unknown','submitted','pending','settled','failed','held')),
    settlement_allowed BOOLEAN NOT NULL DEFAULT false CHECK (settlement_allowed = false),
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    reason TEXT NOT NULL,
    evidence_digest TEXT NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL,
    UNIQUE (idempotency_key, attempt)
);

-- A terminal outcome is immutable and may be recorded only once per payment
-- intent. Inconclusive evidence is not stored in the decision table; it remains
-- represented by the rescheduled queue row.
CREATE UNIQUE INDEX IF NOT EXISTS provider_reconciliation_terminal_once_idx
    ON provider_reconciliation_decision (idempotency_key)
    WHERE decision IN (
        'provider_accepted_no_settlement_authority',
        'confirmed_non_submission',
        'quarantined_reconciliation_failure'
    );

COMMIT;
