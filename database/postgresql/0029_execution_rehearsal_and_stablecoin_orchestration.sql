-- Provider-independent controls for a non-executable approval rehearsal and
-- stablecoin routing readiness. These records do not instruct a provider,
-- create a wallet, move value, mint, redeem, exchange, or settle anything.

BEGIN;

ALTER TABLE integration_connections
  DROP CONSTRAINT IF EXISTS integration_connections_category_check;
ALTER TABLE integration_connections
  ADD CONSTRAINT integration_connections_category_check
  CHECK (category IN (
    'payment_rail', 'fx_rate', 'stablecoin_market_data', 'stablecoin_execution',
    'kyc_kyb', 'sanctions', 'chain_analytics', 'notification', 'regulatory_submission'
  ));

CREATE TABLE stablecoin_orchestration_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  corridor corridor_code NOT NULL,
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'USDT')),
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE RESTRICT,
  integration_connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE RESTRICT,
  requires_travel_rule BOOLEAN NOT NULL DEFAULT TRUE,
  beneficiary_evidence_required BOOLEAN NOT NULL DEFAULT TRUE,
  route_policy_evidence_uri TEXT NOT NULL CHECK (route_policy_evidence_uri ~ '^https://'),
  route_policy_evidence_sha256 CHAR(64) NOT NULL CHECK (route_policy_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  configured_by TEXT NOT NULL,
  configured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (corridor, asset, counterparty_id, integration_connection_id)
);

CREATE TABLE stablecoin_orchestration_route_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id UUID NOT NULL REFERENCES stablecoin_orchestration_routes(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'blocked')),
  rationale TEXT NOT NULL CHECK (char_length(trim(rationale)) BETWEEN 16 AND 4000),
  decided_by TEXT NOT NULL,
  decided_role operating_role NOT NULL CHECK (decided_role IN ('admin', 'compliance_officer')),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE authorised_execution_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE RESTRICT,
  corridor corridor_code NOT NULL,
  test_plan_evidence_uri TEXT NOT NULL CHECK (test_plan_evidence_uri ~ '^https://'),
  authorisation_evidence_uri TEXT,
  status TEXT NOT NULL CHECK (status IN ('documented', 'authorised', 'blocked', 'closed')),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  external_execution_observed BOOLEAN NOT NULL DEFAULT FALSE CHECK (external_execution_observed = FALSE),
  CHECK (
    (status = 'authorised' AND authorisation_evidence_uri IS NOT NULL)
    OR status <> 'authorised'
  )
);

CREATE TABLE execution_approval_rehearsals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_order_id UUID NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE RESTRICT,
  stablecoin_route_id UUID REFERENCES stablecoin_orchestration_routes(id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('blocked', 'ready_for_authorised_execution')),
  prerequisite_snapshot JSONB NOT NULL,
  rationale TEXT NOT NULL CHECK (char_length(trim(rationale)) BETWEEN 16 AND 4000),
  evaluated_by TEXT NOT NULL,
  evaluated_role operating_role NOT NULL,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  external_execution_initiated BOOLEAN NOT NULL DEFAULT FALSE CHECK (external_execution_initiated = FALSE)
);

CREATE INDEX stablecoin_orchestration_routes_lookup_idx
  ON stablecoin_orchestration_routes (corridor, asset, counterparty_id);
CREATE INDEX stablecoin_orchestration_route_reviews_latest_idx
  ON stablecoin_orchestration_route_reviews (route_id, decided_at DESC, id DESC);
CREATE INDEX authorised_execution_tests_readiness_idx
  ON authorised_execution_tests (counterparty_id, corridor, status, recorded_at DESC);
CREATE INDEX execution_approval_rehearsals_order_idx
  ON execution_approval_rehearsals (payment_order_id, evaluated_at DESC);

COMMIT;
