-- Governed analytics outbox. This table never stores customer, account,
-- provider credential, document, or execution authority data. PostgreSQL is
-- the canonical source; lakehouse delivery is a replayable non-authoritative
-- projection.

DO $$ BEGIN
  CREATE TYPE control_evidence_delivery_state AS ENUM ('pending', 'delivered');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS control_evidence_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL CHECK (source = 'postgresql_control'),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'umojaflowos.counterparty.onboarding.created.v1',
    'umojaflowos.counterparty.onboarding.gate-decided.v1',
    'umojaflowos.counterparty.onboarding.recertification-started.v1'
  )),
  correlation_sha256 CHAR(64) NOT NULL CHECK (correlation_sha256 ~ '^[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('created', 'approved', 'blocked', 'recertification_started')),
  corridor corridor_code,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
    payload ? 'authoritative'
    AND payload->>'authoritative' = 'false'
    AND NOT (payload ?| ARRAY['customer_id', 'counterparty_id', 'account_reference', 'wallet_address', 'credential', 'token', 'secret', 'execute', 'settle', 'transfer'])
  ),
  delivery_state control_evidence_delivery_state NOT NULL DEFAULT 'pending',
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  last_delivery_error TEXT,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_type, correlation_sha256)
);

CREATE INDEX IF NOT EXISTS control_evidence_outbox_pending_idx
  ON control_evidence_outbox (created_at)
  WHERE delivery_state = 'pending';

CREATE OR REPLACE FUNCTION enqueue_counterparty_onboarding_created_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO control_evidence_outbox (source, event_type, correlation_sha256, observed_at, outcome, payload)
  VALUES (
    'postgresql_control',
    'umojaflowos.counterparty.onboarding.created.v1',
    encode(digest(NEW.id::text, 'sha256'), 'hex'),
    NEW.created_at,
    'created',
    jsonb_build_object('authoritative', false, 'stage', NEW.stage::text)
  )
  ON CONFLICT (event_type, correlation_sha256) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enqueue_counterparty_onboarding_gate_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO control_evidence_outbox (source, event_type, correlation_sha256, observed_at, outcome, payload)
  VALUES (
    'postgresql_control',
    'umojaflowos.counterparty.onboarding.gate-decided.v1',
    encode(digest(NEW.onboarding_id::text || ':' || NEW.cycle_number::text || ':' || NEW.gate::text || ':' || NEW.decision::text, 'sha256'), 'hex'),
    NEW.decided_at,
    NEW.decision::text,
    jsonb_build_object('authoritative', false, 'gate', NEW.gate::text, 'cycle_number', NEW.cycle_number)
  )
  ON CONFLICT (event_type, correlation_sha256) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION enqueue_counterparty_recertification_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.cycle_number > OLD.cycle_number THEN
    INSERT INTO control_evidence_outbox (source, event_type, correlation_sha256, observed_at, outcome, payload)
    VALUES (
      'postgresql_control',
      'umojaflowos.counterparty.onboarding.recertification-started.v1',
      encode(digest(NEW.id::text || ':' || NEW.cycle_number::text, 'sha256'), 'hex'),
      NEW.updated_at,
      'recertification_started',
      jsonb_build_object('authoritative', false, 'cycle_number', NEW.cycle_number)
    )
    ON CONFLICT (event_type, correlation_sha256) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS counterparty_onboarding_created_evidence_trigger ON counterparty_onboardings;
CREATE TRIGGER counterparty_onboarding_created_evidence_trigger
  AFTER INSERT ON counterparty_onboardings
  FOR EACH ROW EXECUTE FUNCTION enqueue_counterparty_onboarding_created_evidence();

DROP TRIGGER IF EXISTS counterparty_onboarding_gate_evidence_trigger ON counterparty_onboarding_gate_decisions;
CREATE TRIGGER counterparty_onboarding_gate_evidence_trigger
  AFTER INSERT ON counterparty_onboarding_gate_decisions
  FOR EACH ROW EXECUTE FUNCTION enqueue_counterparty_onboarding_gate_evidence();

DROP TRIGGER IF EXISTS counterparty_onboarding_recertification_evidence_trigger ON counterparty_onboardings;
CREATE TRIGGER counterparty_onboarding_recertification_evidence_trigger
  AFTER UPDATE OF cycle_number ON counterparty_onboardings
  FOR EACH ROW EXECUTE FUNCTION enqueue_counterparty_recertification_evidence();
