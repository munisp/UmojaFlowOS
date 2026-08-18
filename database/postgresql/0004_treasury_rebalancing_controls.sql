-- Provider-independent treasury recommendation controls.
-- These records create and approve recommendations only; they never initiate a transfer.

BEGIN;

CREATE TYPE treasury_recommendation_status AS ENUM ('proposed', 'approved', 'rejected', 'expired', 'superseded');
CREATE TYPE treasury_stress_test_status AS ENUM ('completed', 'input_unavailable', 'input_stale', 'input_inconsistent');

CREATE TABLE treasury_buffer_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    corridor corridor_code NOT NULL,
    currency TEXT NOT NULL CHECK (currency IN ('NGN', 'KES', 'ZAR')),
    policy_version TEXT NOT NULL,
    approved_daily_outflow NUMERIC(30, 12) NOT NULL CHECK (approved_daily_outflow > 0),
    minimum_buffer_pct NUMERIC(8, 6) NOT NULL CHECK (minimum_buffer_pct > 0 AND minimum_buffer_pct < 1),
    target_buffer_pct NUMERIC(8, 6) NOT NULL CHECK (target_buffer_pct > minimum_buffer_pct AND target_buffer_pct < 1),
    amber_buffer_pct NUMERIC(8, 6) NOT NULL CHECK (amber_buffer_pct >= minimum_buffer_pct AND amber_buffer_pct < target_buffer_pct),
    max_recommendation_pct_of_target NUMERIC(8, 6) NOT NULL CHECK (max_recommendation_pct_of_target > 0 AND max_recommendation_pct_of_target <= 1),
    permitted_account_kinds TEXT[] NOT NULL CHECK (cardinality(permitted_account_kinds) > 0),
    source_period_start DATE NOT NULL,
    source_period_end DATE NOT NULL,
    source_reference TEXT NOT NULL,
    policy_document_uri TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    approved_at TIMESTAMPTZ NOT NULL,
    effective_from TIMESTAMPTZ NOT NULL,
    effective_to TIMESTAMPTZ,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (source_period_end >= source_period_start),
    CHECK (effective_to IS NULL OR effective_to > effective_from),
    CHECK ((corridor = 'NIGERIA_NGN' AND currency = 'NGN') OR (corridor = 'KENYA_KES' AND currency = 'KES') OR (corridor = 'SOUTH_AFRICA_ZAR' AND currency = 'ZAR')),
    UNIQUE (corridor, policy_version)
);

CREATE TABLE treasury_rebalancing_recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buffer_policy_id UUID NOT NULL REFERENCES treasury_buffer_policies(id),
    corridor corridor_code NOT NULL,
    currency TEXT NOT NULL CHECK (currency IN ('NGN', 'KES', 'ZAR')),
    reconciled_available_balance NUMERIC(30, 12) NOT NULL CHECK (reconciled_available_balance >= 0),
    reconciled_at TIMESTAMPTZ NOT NULL,
    balance_source_reference TEXT NOT NULL,
    verified_near_term_funding_gap NUMERIC(30, 12) NOT NULL CHECK (verified_near_term_funding_gap >= 0),
    funding_gap_source_reference TEXT NOT NULL,
    minimum_buffer_amount NUMERIC(30, 12) NOT NULL CHECK (minimum_buffer_amount >= 0),
    target_buffer_amount NUMERIC(30, 12) NOT NULL CHECK (target_buffer_amount >= minimum_buffer_amount),
    computed_recommendation_amount NUMERIC(30, 12) NOT NULL CHECK (computed_recommendation_amount >= 0),
    calculation_evidence JSONB NOT NULL,
    status treasury_recommendation_status NOT NULL DEFAULT 'proposed',
    proposed_by TEXT NOT NULL,
    proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_by TEXT,
    decided_at TIMESTAMPTZ,
    decision_reason TEXT,
    expires_at TIMESTAMPTZ NOT NULL,
    CHECK (expires_at > proposed_at),
    CHECK ((status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL))
);

CREATE TABLE treasury_stress_test_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buffer_policy_id UUID NOT NULL REFERENCES treasury_buffer_policies(id),
    scenario_code TEXT NOT NULL,
    outflow_multiplier NUMERIC(8, 6) NOT NULL CHECK (outflow_multiplier >= 1),
    input_status treasury_stress_test_status NOT NULL,
    reconciled_available_balance NUMERIC(30, 12),
    stressed_daily_outflow NUMERIC(30, 12),
    stressed_minimum_buffer NUMERIC(30, 12),
    stressed_target_buffer NUMERIC(30, 12),
    computed_recommendation_amount NUMERIC(30, 12),
    limitation TEXT,
    evidence JSONB NOT NULL,
    run_by TEXT NOT NULL,
    run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((input_status = 'completed') = (reconciled_available_balance IS NOT NULL AND stressed_daily_outflow IS NOT NULL AND stressed_minimum_buffer IS NOT NULL AND stressed_target_buffer IS NOT NULL AND computed_recommendation_amount IS NOT NULL))
);

CREATE INDEX treasury_buffer_policies_active_idx ON treasury_buffer_policies (corridor, effective_from DESC) WHERE effective_to IS NULL;
CREATE INDEX treasury_recommendations_status_idx ON treasury_rebalancing_recommendations (corridor, status, proposed_at DESC);
CREATE INDEX treasury_stress_test_runs_idx ON treasury_stress_test_runs (buffer_policy_id, scenario_code, run_at DESC);

COMMIT;
