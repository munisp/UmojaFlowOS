BEGIN;

CREATE TABLE stablecoin_settlement_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_order_id UUID NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
  payment_leg_id UUID NOT NULL REFERENCES payment_legs(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  payload_sha256 CHAR(64) NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  direction TEXT NOT NULL CHECK (direction IN ('onramp', 'offramp')),
  asset TEXT NOT NULL CHECK (asset IN ('USDC', 'USDT')),
  fiat_currency TEXT NOT NULL CHECK (fiat_currency IN ('NGN', 'KES', 'ZAR', 'USD')),
  amount_minor NUMERIC(30,0) NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'submitted', 'pending', 'settled', 'held', 'failed', 'unknown', 'refunded', 'blocked')),
  provider_reference TEXT,
  blockchain_transaction_hash TEXT,
  provider_payload_sha256 CHAR(64) CHECK (provider_payload_sha256 IS NULL OR provider_payload_sha256 ~ '^[a-f0-9]{64}$'),
  failure_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (idempotency_key, direction),
  UNIQUE (payment_leg_id, direction),
  CHECK (status IN ('prepared', 'unknown') OR provider_reference IS NOT NULL),
  CHECK (status <> 'settled' OR blockchain_transaction_hash IS NOT NULL OR provider_reference IS NOT NULL),
  CHECK (status NOT IN ('failed', 'held', 'blocked', 'refunded') OR failure_reason IS NOT NULL)
);

CREATE UNIQUE INDEX stablecoin_settlement_terminal_once_idx
  ON stablecoin_settlement_attempts (idempotency_key, direction)
  WHERE status IN ('settled', 'failed', 'refunded', 'blocked');

CREATE INDEX stablecoin_settlement_reconciliation_idx
  ON stablecoin_settlement_attempts (status, updated_at DESC)
  WHERE status IN ('unknown', 'pending', 'held');

CREATE INDEX stablecoin_settlement_provider_reference_idx
  ON stablecoin_settlement_attempts (provider_reference)
  WHERE provider_reference IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_stablecoin_settlement_identity_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.direction IS DISTINCT FROM OLD.direction
     OR NEW.payload_sha256 IS DISTINCT FROM OLD.payload_sha256
     OR NEW.payment_order_id IS DISTINCT FROM OLD.payment_order_id
     OR NEW.payment_leg_id IS DISTINCT FROM OLD.payment_leg_id
     OR NEW.asset IS DISTINCT FROM OLD.asset
     OR NEW.fiat_currency IS DISTINCT FROM OLD.fiat_currency
     OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
  THEN
    RAISE EXCEPTION 'stablecoin settlement identity is immutable';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER stablecoin_settlement_identity_immutable
BEFORE UPDATE ON stablecoin_settlement_attempts
FOR EACH ROW EXECUTE FUNCTION enforce_stablecoin_settlement_identity_immutable();

INSERT INTO activity_events (actor_subject, actor_role, action, object_type, object_id, metadata)
SELECT 'migration:0055', 'admin', 'schema.stablecoin_settlement_idempotency_installed', 'schema', gen_random_uuid(), '{"fail_closed":true}'::jsonb
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'activity_events');

COMMIT;
