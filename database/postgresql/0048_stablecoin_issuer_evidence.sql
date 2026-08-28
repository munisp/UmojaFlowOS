BEGIN;

-- OM §8.2 archetype taxonomy for stablecoin issuers and networks.
CREATE TYPE stablecoin_issuer_archetype AS ENUM ('regulated_issuer', 'open_issuer', 'network');

ALTER TABLE counterparties
  ADD COLUMN stablecoin_issuer_archetype stablecoin_issuer_archetype;

-- OM §8.4's 11-item issuer evidence pack.
CREATE TYPE stablecoin_issuer_evidence_type AS ENUM (
  'issuer_regulatory_licence',
  'reserve_attestation',
  'reserve_asset_composition',
  'aml_cft_policy',
  'sanctions_ofac_attestation',
  'blockchain_finality_posture',
  'custody_provider_licence_insurance',
  'network_fee_schedule',
  'principal_beneficial_ownership_kyb',
  'audited_financials',
  'smart_contract_audit'
);

CREATE TABLE stablecoin_issuer_evidence_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id UUID NOT NULL REFERENCES counterparties(id),
  evidence_type stablecoin_issuer_evidence_type NOT NULL,
  evidence_uri TEXT NOT NULL,
  note TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX stablecoin_issuer_evidence_items_counterparty_idx
  ON stablecoin_issuer_evidence_items (counterparty_id, recorded_at DESC);

-- OM §8.6 defines four issuer-specific gates (G1 licence+reserve posture,
-- G2 mint/redeem technical proof, G3 chain readiness, G4 operating posture)
-- whose pass criteria -- reserve-attestation cadence, three full mint/redeem
-- cycles, chain finality, a de-peg stress test -- have no equivalent in the
-- shared legal/technical/pilot lifecycle, so all four live here rather than
-- reusing counterparty_onboarding_gate_decisions, matching the treatment
-- used for payout PSPs (Ch.7) rather than the looser LP/Bank approximation.
CREATE TYPE stablecoin_issuer_gate AS ENUM ('licence_reserve_posture', 'mint_redeem_technical_proof', 'chain_readiness', 'operating_posture');

CREATE TABLE stablecoin_issuer_gate_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id UUID NOT NULL REFERENCES counterparty_onboardings(id),
  cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
  gate stablecoin_issuer_gate NOT NULL,
  decision counterparty_onboarding_decision NOT NULL,
  rationale TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_role operating_role NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX stablecoin_issuer_gate_decisions_onboarding_idx
  ON stablecoin_issuer_gate_decisions (onboarding_id, cycle_number, gate, decided_at DESC);

COMMIT;
