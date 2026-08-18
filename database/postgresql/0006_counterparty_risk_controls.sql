-- Provider-independent counterparty risk assessment and review controls.
BEGIN;

CREATE TYPE counterparty_risk_level AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE counterparty_review_status AS ENUM ('current', 'due', 'overdue', 'escalated');

CREATE TABLE counterparty_risk_assessments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    counterparty_id UUID NOT NULL REFERENCES counterparties(id),
    risk_level counterparty_risk_level NOT NULL,
    risk_score NUMERIC(5, 2) NOT NULL CHECK (risk_score >= 0 AND risk_score <= 100),
    risk_factors JSONB NOT NULL,
    evidence_manifest JSONB NOT NULL,
    assessed_at TIMESTAMPTZ NOT NULL,
    next_review_at TIMESTAMPTZ NOT NULL,
    assessed_by TEXT NOT NULL,
    review_status counterparty_review_status NOT NULL DEFAULT 'current',
    escalation_reason TEXT,
    escalated_by TEXT,
    escalated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (next_review_at > assessed_at),
    CHECK ((review_status = 'escalated') = (escalation_reason IS NOT NULL AND escalated_by IS NOT NULL AND escalated_at IS NOT NULL))
);

CREATE INDEX counterparty_risk_assessments_review_idx ON counterparty_risk_assessments (review_status, next_review_at);
CREATE INDEX counterparty_risk_assessments_counterparty_idx ON counterparty_risk_assessments (counterparty_id, assessed_at DESC);

COMMIT;
