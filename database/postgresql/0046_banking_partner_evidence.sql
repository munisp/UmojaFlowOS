BEGIN;

-- OM §6.2 archetype taxonomy for banking partners. Nullable and not
-- constrained to counterparty_type = 'correspondent_bank' at the schema
-- level, matching the archetype pattern used for customers and LPs.
CREATE TYPE bank_archetype AS ENUM ('correspondent_bank', 'receiving_bank', 'settlement_bank', 'custodian_bank', 'issuing_bank');

ALTER TABLE counterparties
  ADD COLUMN bank_archetype bank_archetype;

-- OM §6.4's 12-item banking-partner evidence pack. A separate table (and
-- enum) from the liquidity-provider evidence pack: the two lists overlap in
-- a couple of names (a sanctions policy, an audit trail) but are otherwise
-- genuinely different evidence, so collapsing them into one polymorphic
-- enum would blur what "present" actually means for either chapter.
CREATE TYPE bank_evidence_type AS ENUM (
  'banking_licence',
  'aml_cft_attestation',
  'correspondent_agreement_template',
  'nostro_account_confirmation',
  'sanctions_policy',
  'travel_rule_readiness_attestation',
  'swift_message_support_confirmation',
  'fee_schedule',
  'audit_reports',
  'regulator_no_objection_letter',
  'cyber_bcm_evidence',
  'settlement_cutoff_calendar'
);

CREATE TABLE bank_evidence_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id UUID NOT NULL REFERENCES counterparties(id),
  evidence_type bank_evidence_type NOT NULL,
  evidence_uri TEXT NOT NULL,
  note TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX bank_evidence_items_counterparty_idx
  ON bank_evidence_items (counterparty_id, recorded_at DESC);

-- OM §6.6 Gate G2 (crypto / VASP posture — Compliance+Country Lead), which
-- the generic 'legal'/'technical'/'pilot' gate model has no equivalent for.
-- Kept independent of that shared model for the same reason the LP
-- financial-soundness gate is: it doesn't block or advance
-- counterparty_onboardings.stage, since that stage machine is shared by
-- every other counterparty type.
CREATE TABLE counterparty_crypto_posture_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id UUID NOT NULL REFERENCES counterparty_onboardings(id),
  cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
  decision counterparty_onboarding_decision NOT NULL,
  rationale TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_role operating_role NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX counterparty_crypto_posture_decisions_onboarding_idx
  ON counterparty_crypto_posture_decisions (onboarding_id, cycle_number, decided_at DESC);

COMMIT;
