BEGIN;

CREATE OR REPLACE FUNCTION enforce_stablecoin_terminal_decision_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('settled', 'failed', 'refunded', 'blocked')
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference
          OR NEW.blockchain_transaction_hash IS DISTINCT FROM OLD.blockchain_transaction_hash
          OR NEW.failure_reason IS DISTINCT FROM OLD.failure_reason)
  THEN
    RAISE EXCEPTION 'stablecoin terminal decision is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stablecoin_terminal_decision_immutable ON stablecoin_settlement_attempts;
CREATE TRIGGER stablecoin_terminal_decision_immutable
BEFORE UPDATE ON stablecoin_settlement_attempts
FOR EACH ROW EXECUTE FUNCTION enforce_stablecoin_terminal_decision_immutable();

COMMIT;
