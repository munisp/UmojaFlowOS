-- Canonical compliance alert records.
--
-- An alert is an operator-facing record that something requires attention. It is
-- deliberately NOT a decision: it can be acknowledged, escalated, or dismissed
-- with a reason, but it never approves, clears, or blocks anything by itself.
-- Any binding outcome must be reached through a compliance case, which is why
-- escalation records the case the alert was escalated into.

CREATE TYPE compliance_alert_state AS ENUM (
    'open',
    'acknowledged',
    'escalated',
    'dismissed'
);

CREATE TABLE compliance_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Which configured policy produced this alert. Alerts cannot exist without a
    -- policy, so an alert can always be traced to the rule that raised it.
    alert_policy_id UUID NOT NULL REFERENCES alert_policies(id),

    alert_type TEXT NOT NULL CHECK (
        alert_type IN (
            'liquidity_threshold',
            'payment_failure',
            'compliance_flag',
            'regulatory_deadline'
        )
    ),
    corridor corridor_code,
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),

    state compliance_alert_state NOT NULL DEFAULT 'open',

    -- Originating evidence. Every alert must carry a verifiable reference to the
    -- observation, position, order, or job that triggered it, plus the evidence
    -- payload that was true at the moment of detection.
    source_reference TEXT NOT NULL CHECK (length(trim(source_reference)) >= 8),
    evidence JSONB NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL,

    -- Optional links to the subject of the alert.
    payment_order_id UUID REFERENCES payment_orders(id),
    customer_id UUID REFERENCES customers(id),
    counterparty_id UUID REFERENCES counterparties(id),

    -- Acknowledgement: an operator has seen the alert and stated what they
    -- observed. This resolves nothing on its own.
    acknowledged_by TEXT,
    acknowledged_by_role operating_role,
    acknowledged_at TIMESTAMPTZ,
    acknowledgement_note TEXT,

    -- Escalation: the alert became a compliance case. The case link is mandatory
    -- for the escalated state so an escalation can never be a dead end.
    escalated_case_id UUID REFERENCES compliance_cases(id),
    escalated_by TEXT,
    escalated_by_role operating_role,
    escalated_at TIMESTAMPTZ,

    -- Dismissal: explicitly recorded as a non-decision with a stated reason.
    dismissed_by TEXT,
    dismissed_by_role operating_role,
    dismissed_at TIMESTAMPTZ,
    dismissal_reason TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Deduplication: one open alert per policy and source reference, so a
    -- repeatedly evaluated condition does not flood the queue.
    UNIQUE (alert_policy_id, source_reference),

    -- State integrity: each terminal state must carry its actor and rationale.
    CONSTRAINT compliance_alerts_acknowledged_complete CHECK (
        state <> 'acknowledged'
        OR (acknowledged_by IS NOT NULL
            AND acknowledged_by_role IS NOT NULL
            AND acknowledged_at IS NOT NULL
            AND acknowledgement_note IS NOT NULL
            AND length(trim(acknowledgement_note)) >= 8)
    ),
    CONSTRAINT compliance_alerts_escalated_complete CHECK (
        state <> 'escalated'
        OR (escalated_case_id IS NOT NULL
            AND escalated_by IS NOT NULL
            AND escalated_by_role IS NOT NULL
            AND escalated_at IS NOT NULL)
    ),
    CONSTRAINT compliance_alerts_dismissed_complete CHECK (
        state <> 'dismissed'
        OR (dismissed_by IS NOT NULL
            AND dismissed_by_role IS NOT NULL
            AND dismissed_at IS NOT NULL
            AND dismissal_reason IS NOT NULL
            AND length(trim(dismissal_reason)) >= 8)
    )
);

CREATE INDEX compliance_alerts_state_idx
    ON compliance_alerts (state, severity, detected_at DESC);

CREATE INDEX compliance_alerts_corridor_idx
    ON compliance_alerts (corridor, state, detected_at DESC);
