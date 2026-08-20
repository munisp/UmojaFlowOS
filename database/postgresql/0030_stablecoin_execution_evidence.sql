-- Immutable evidence references required before a USDC/USDT route can be
-- rehearsed as ready for an authorised execution path. No document bytes,
-- wallet operation, transfer, custody, or provider instruction is stored here.

BEGIN;

CREATE TABLE stablecoin_execution_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_order_id UUID NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
  route_id UUID NOT NULL REFERENCES stablecoin_orchestration_routes(id) ON DELETE RESTRICT,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('travel_rule', 'beneficiary_verification', 'wallet_ownership')),
  evidence_uri TEXT NOT NULL CHECK (evidence_uri ~ '^https://'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_order_id, route_id, evidence_kind, evidence_sha256)
);

CREATE INDEX stablecoin_execution_evidence_lookup_idx
  ON stablecoin_execution_evidence (payment_order_id, route_id, evidence_kind, recorded_at DESC);

COMMIT;
