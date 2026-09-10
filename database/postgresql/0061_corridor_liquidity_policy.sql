BEGIN;

CREATE TABLE IF NOT EXISTS corridor_routes (
    route_id text PRIMARY KEY,
    tenant_id text NOT NULL,
    CONSTRAINT corridor_routes_route_tenant_unique UNIQUE (route_id, tenant_id),
    origin_country char(2) NOT NULL CHECK (origin_country ~ '^[A-Z]{2}$'),
    destination_country char(2) NOT NULL CHECK (destination_country ~ '^[A-Z]{2}$'),
    source_currency char(3) NOT NULL CHECK (source_currency ~ '^[A-Z]{3}$'),
    destination_currency char(3) NOT NULL CHECK (destination_currency ~ '^[A-Z]{3}$'),
    direction text NOT NULL CHECK (direction IN ('onramp', 'offramp')),
    asset text NOT NULL,
    rails jsonb NOT NULL CHECK (jsonb_typeof(rails) = 'array' AND jsonb_array_length(rails) > 0),
    provider_priority jsonb NOT NULL CHECK (jsonb_typeof(provider_priority) = 'array' AND jsonb_array_length(provider_priority) > 0),
    min_amount_minor bigint NOT NULL CHECK (min_amount_minor > 0),
    max_amount_minor bigint CHECK (max_amount_minor IS NULL OR max_amount_minor >= min_amount_minor),
    quote_ttl_seconds integer NOT NULL CHECK (quote_ttl_seconds BETWEEN 1 AND 86400),
    liquidity_buffer_bps integer NOT NULL CHECK (liquidity_buffer_bps BETWEEN 0 AND 10000),
    settlement_cutoff timestamptz,
    enabled boolean NOT NULL DEFAULT false,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS corridor_routes_lookup_idx ON corridor_routes
    (tenant_id, origin_country, destination_country, source_currency, direction, asset)
    WHERE enabled = true;

CREATE TABLE IF NOT EXISTS liquidity_treasury_evidence (
    evidence_id text PRIMARY KEY,
    tenant_id text NOT NULL,
    route_id text NOT NULL,
    provider text NOT NULL,
    currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    available_minor bigint NOT NULL CHECK (available_minor >= 0),
    reserved_minor bigint NOT NULL CHECK (reserved_minor >= 0),
    required_buffer_minor bigint NOT NULL CHECK (required_buffer_minor >= 0),
    observed_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > observed_at),
    source text NOT NULL,
    evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (available_minor >= reserved_minor)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'corridor_routes_route_tenant_unique'
    ) THEN
        ALTER TABLE corridor_routes
            ADD CONSTRAINT corridor_routes_route_tenant_unique UNIQUE (route_id, tenant_id);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'liquidity_evidence_route_tenant_fk'
    ) THEN
        ALTER TABLE liquidity_treasury_evidence
            ADD CONSTRAINT liquidity_evidence_route_tenant_fk
            FOREIGN KEY (route_id, tenant_id)
            REFERENCES corridor_routes (route_id, tenant_id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS liquidity_evidence_lookup_idx ON liquidity_treasury_evidence
    (tenant_id, route_id, provider, currency, expires_at DESC);

ALTER TABLE corridor_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE liquidity_treasury_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY corridor_routes_tenant_isolation ON corridor_routes
    USING (tenant_id = current_setting('umoja.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('umoja.tenant_id', true));

CREATE POLICY liquidity_evidence_tenant_isolation ON liquidity_treasury_evidence
    USING (tenant_id = current_setting('umoja.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('umoja.tenant_id', true));

COMMENT ON TABLE corridor_routes IS 'Tenant-scoped approved corridor routing policy; disabled or ambiguous routes must not release settlement.';
COMMENT ON TABLE liquidity_treasury_evidence IS 'Immutable-ish provider/treasury evidence used for fail-closed liquidity admission before ledger posting. The composite route/tenant foreign key prevents cross-tenant route binding.';

COMMIT;
