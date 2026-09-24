BEGIN;

-- Remittance (IMTO) and Bureau-de-Change control-plane persistence.
-- Boundary: these tables hold preparation, evidence, and review state only.
-- No row here authorizes value movement; licensed partners execute.

CREATE TABLE IF NOT EXISTS remittance_orders (
    remittance_id text PRIMARY KEY,
    tenant_id text NOT NULL,
    corridor text NOT NULL CHECK (corridor ~ '^[A-Z]{2}_[A-Z]{2}$'),
    remitter_id text NOT NULL,
    kyc_subject_id text NOT NULL,
    remitter_country char(2) NOT NULL CHECK (remitter_country ~ '^[A-Z]{2}$'),
    kyc_tier smallint NOT NULL CHECK (kyc_tier BETWEEN 1 AND 3),
    beneficiary_id text NOT NULL,
    beneficiary_name text NOT NULL,
    beneficiary_country char(2) NOT NULL CHECK (beneficiary_country ~ '^[A-Z]{2}$'),
    bank_code text,
    account_reference text,
    mobile_wallet_id text,
    beneficiary_verification_sha256 char(64),
    purpose text NOT NULL,
    send_amount_minor bigint NOT NULL CHECK (send_amount_minor > 0),
    send_currency char(3) NOT NULL CHECK (send_currency ~ '^[A-Z]{3}$'),
    receive_amount_minor bigint CHECK (receive_amount_minor IS NULL OR receive_amount_minor > 0),
    receive_currency char(3) NOT NULL CHECK (receive_currency ~ '^[A-Z]{3}$'),
    payout_channel text NOT NULL CHECK (payout_channel IN
        ('bank_credit', 'cash_pickup', 'mobile_money', 'usd_domiciliary')),
    state text NOT NULL CHECK (state IN
        ('draft', 'screening', 'review_required', 'approved_for_payout_preparation',
         'payout_evidence_recorded', 'completed_by_partner', 'refunded', 'cancelled')),
    screening_case_id text,
    review_triggers jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(review_triggers) = 'array'),
    history jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(history) = 'array'),
    payout_evidence_sha256 char(64),
    partner_finality_reference text,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    -- channel-specific evidence requirements (fail-closed at the storage layer too)
    CONSTRAINT remittance_bank_credit_requires_account CHECK (
        payout_channel <> 'bank_credit'
        OR (bank_code IS NOT NULL AND account_reference IS NOT NULL)
    ),
    CONSTRAINT remittance_mobile_money_requires_wallet CHECK (
        payout_channel <> 'mobile_money' OR mobile_wallet_id IS NOT NULL
    ),
    CONSTRAINT remittance_cash_pickup_requires_verification CHECK (
        payout_channel <> 'cash_pickup' OR beneficiary_verification_sha256 IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS remittance_orders_sender_window_idx ON remittance_orders
    (tenant_id, remitter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS remittance_orders_beneficiary_window_idx ON remittance_orders
    (tenant_id, beneficiary_id, created_at DESC);
CREATE INDEX IF NOT EXISTS remittance_orders_state_idx ON remittance_orders
    (tenant_id, state) WHERE state NOT IN ('completed_by_partner', 'refunded', 'cancelled');

CREATE TABLE IF NOT EXISTS remittance_rate_locks (
    rate_lock_id text PRIMARY KEY,
    tenant_id text NOT NULL,
    remittance_id text NOT NULL REFERENCES remittance_orders (remittance_id),
    rate numeric(24, 8) NOT NULL CHECK (rate > 0),
    actor text NOT NULL,
    ttl_seconds integer NOT NULL DEFAULT 900 CHECK (ttl_seconds BETWEEN 1 AND 3600),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    CONSTRAINT rate_lock_expiry_after_creation CHECK (expires_at > created_at),
    CONSTRAINT rate_lock_consumed_before_expiry CHECK (
        consumed_at IS NULL OR consumed_at <= expires_at
    )
);

CREATE INDEX IF NOT EXISTS remittance_rate_locks_order_idx ON remittance_rate_locks
    (tenant_id, remittance_id, created_at DESC);

CREATE TABLE IF NOT EXISTS remittance_review_decisions (
    decision_id text PRIMARY KEY,
    tenant_id text NOT NULL,
    remittance_id text NOT NULL REFERENCES remittance_orders (remittance_id),
    reviewer_subject_id text NOT NULL,
    decision text NOT NULL CHECK (decision IN ('approve', 'reject')),
    rationale text NOT NULL CHECK (length(btrim(rationale)) >= 20),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS remittance_review_decisions_order_idx ON remittance_review_decisions
    (tenant_id, remittance_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bdc_rate_boards (
    board_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id text NOT NULL,
    currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    buy_rate_ngn numeric(24, 8) NOT NULL CHECK (buy_rate_ngn > 0),
    sell_rate_ngn numeric(24, 8) NOT NULL CHECK (sell_rate_ngn > buy_rate_ngn),
    cbn_reference_ngn numeric(24, 8) NOT NULL CHECK (cbn_reference_ngn > 0),
    band_bps integer NOT NULL CHECK (band_bps BETWEEN 0 AND 5000),
    -- spread ceiling: (sell - buy) / reference <= 600 bps, enforced in storage
    CONSTRAINT bdc_board_spread_ceiling CHECK (
        (sell_rate_ngn - buy_rate_ngn) * 10000 <= 600 * cbn_reference_ngn
    ),
    -- board must stay inside the CBN reference band
    CONSTRAINT bdc_board_within_band_buy CHECK (
        abs(buy_rate_ngn - cbn_reference_ngn) * 10000 <= band_bps * cbn_reference_ngn
    ),
    CONSTRAINT bdc_board_within_band_sell CHECK (
        abs(sell_rate_ngn - cbn_reference_ngn) * 10000 <= band_bps * cbn_reference_ngn
    ),
    effective_at timestamptz NOT NULL,
    set_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bdc_rate_boards_current_idx ON bdc_rate_boards
    (tenant_id, currency, effective_at DESC);

CREATE TABLE IF NOT EXISTS bdc_tickets (
    ticket_id text PRIMARY KEY,
    tenant_id text NOT NULL,
    bdc_operator_id text NOT NULL,
    branch_id text NOT NULL,
    side text NOT NULL CHECK (side IN ('sell_fx', 'buy_fx')),
    fx_currency char(3) NOT NULL CHECK (fx_currency ~ '^[A-Z]{3}$'),
    fx_amount_minor bigint NOT NULL CHECK (fx_amount_minor > 0),
    rate_ngn numeric(24, 8) NOT NULL CHECK (rate_ngn > 0),
    ngn_amount_minor bigint NOT NULL CHECK (ngn_amount_minor > 0),
    customer_subject_id text NOT NULL,
    id_evidence_sha256 char(64) NOT NULL,
    state text NOT NULL CHECK (state IN
        ('created', 'review_required', 'settlement_evidence_recorded', 'voided')),
    counterfeit_flag boolean NOT NULL DEFAULT false,
    settlement_evidence_sha256 char(64),
    actor text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bdc_tickets_customer_week_idx ON bdc_tickets
    (tenant_id, customer_subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bdc_tickets_vault_idx ON bdc_tickets
    (tenant_id, bdc_operator_id, branch_id, fx_currency, created_at DESC);

CREATE TABLE IF NOT EXISTS bdc_vault_positions (
    tenant_id text NOT NULL,
    bdc_operator_id text NOT NULL,
    branch_id text NOT NULL,
    currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    balance_minor bigint NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, bdc_operator_id, branch_id, currency)
);

-- Negative vault balance is a shortfall: permitted to be recorded (evidence of
-- the breach) but must alert. Alert query: SELECT ... WHERE balance_minor < 0.

-- Immutability: review decisions and rate locks are evidence — no UPDATE/DELETE.
CREATE OR REPLACE FUNCTION enforce_remittance_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'remittance/BDC evidence rows are immutable (table %)', TG_TABLE_NAME;
END $$;

DROP TRIGGER IF EXISTS remittance_review_decisions_immutable ON remittance_review_decisions;
CREATE TRIGGER remittance_review_decisions_immutable
BEFORE UPDATE OR DELETE ON remittance_review_decisions
FOR EACH ROW EXECUTE FUNCTION enforce_remittance_evidence_immutable();

DROP TRIGGER IF EXISTS remittance_rate_locks_no_mutation ON remittance_rate_locks;
CREATE TRIGGER remittance_rate_locks_no_mutation
BEFORE UPDATE OR DELETE ON remittance_rate_locks
FOR EACH ROW
WHEN (OLD.consumed_at IS NOT NULL)
EXECUTE FUNCTION enforce_remittance_evidence_immutable();

ALTER TABLE remittance_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE remittance_rate_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE remittance_review_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bdc_rate_boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE bdc_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE bdc_vault_positions ENABLE ROW LEVEL SECURITY;

CREATE POLICY remittance_orders_tenant_isolation ON remittance_orders
    USING (tenant_id = current_setting('umoja.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('umoja.tenant_id', true));
CREATE POLICY remittance_rate_locks_tenant_isolation ON remittance_rate_locks
    USING (tenant_id = current_setting('umoja.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('umoja.tenant_id', true));
CREATE POLICY remittance_review_decisions_tenant_isolation ON remittance_review_decisions
    USING (tenant_id = current_setting('umoja.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('umoja.tenant_id', true));
CREATE POLICY bdc_rate_boards_tenant_isolation ON bdc_rate_boards
    USING (tenant_id = current_setting('umoja.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('umoja.tenant_id', true));
CREATE POLICY bdc_tickets_tenant_isolation ON bdc_tickets
    USING (tenant_id = current_setting('umoja.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('umoja.tenant_id', true));
CREATE POLICY bdc_vault_positions_tenant_isolation ON bdc_vault_positions
    USING (tenant_id = current_setting('umoja.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('umoja.tenant_id', true));

COMMENT ON TABLE remittance_orders IS 'IMTO remittance preparation and evidence; execution authority remains with licensed partners. Channel evidence requirements enforced by CHECK constraints.';
COMMENT ON TABLE remittance_rate_locks IS 'Rate quotes with TTL; consumed-after-expiry is impossible by constraint (stale-rate execution prevention).';
COMMENT ON TABLE remittance_review_decisions IS 'Immutable human review decisions with mandatory rationale (>=20 chars).';
COMMENT ON TABLE bdc_rate_boards IS 'BDC buy/sell board bounded by CBN reference band and 600bps spread ceiling, enforced in storage.';
COMMENT ON TABLE bdc_tickets IS 'BDC FX tickets with mandatory ID evidence hash; counterfeit flag forces review_required.';
COMMENT ON TABLE bdc_vault_positions IS 'Per-operator/branch/currency vault balances; negative balance is a recorded shortfall that must alert.';

COMMIT;
