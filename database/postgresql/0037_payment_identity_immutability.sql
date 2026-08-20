BEGIN;

CREATE OR REPLACE FUNCTION prohibit_payment_order_identity_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.beneficiary_id IS DISTINCT FROM OLD.beneficiary_id
     OR NEW.corridor IS DISTINCT FROM OLD.corridor
     OR NEW.source_currency IS DISTINCT FROM OLD.source_currency
     OR NEW.source_amount IS DISTINCT FROM OLD.source_amount
     OR NEW.target_currency IS DISTINCT FROM OLD.target_currency
     OR NEW.target_amount IS DISTINCT FROM OLD.target_amount
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment order economic identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION prohibit_payment_leg_identity_rewrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_order_id IS DISTINCT FROM OLD.payment_order_id
     OR NEW.sequence_number IS DISTINCT FROM OLD.sequence_number
     OR NEW.leg_kind IS DISTINCT FROM OLD.leg_kind
     OR NEW.counterparty_id IS DISTINCT FROM OLD.counterparty_id THEN
    RAISE EXCEPTION 'payment leg economic identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_order_identity_immutable ON payment_orders;
CREATE TRIGGER payment_order_identity_immutable BEFORE UPDATE ON payment_orders
FOR EACH ROW EXECUTE FUNCTION prohibit_payment_order_identity_rewrite();

DROP TRIGGER IF EXISTS payment_leg_identity_immutable ON payment_legs;
CREATE TRIGGER payment_leg_identity_immutable BEFORE UPDATE ON payment_legs
FOR EACH ROW EXECUTE FUNCTION prohibit_payment_leg_identity_rewrite();

COMMIT;
