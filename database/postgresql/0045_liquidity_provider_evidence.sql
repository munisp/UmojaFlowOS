BEGIN;

-- OM §5.2 archetype taxonomy for liquidity providers. Nullable and not
-- constrained to counterparty_type = 'fx_liquidity_provider' at the schema
-- level, matching how customer archetype is handled: existing records
-- predate this classification.
CREATE TYPE lp_archetype AS ENUM ('principal_market_maker', 'regional_liquidity_desk', 'stablecoin_fiat_conversion_desk', 'otc_counterparty');

ALTER TABLE counterparties
  ADD COLUMN lp_archetype lp_archetype;

-- OM §5.4's 12-item liquidity-provider evidence pack. Scoped to
-- counterparty_id (not a single onboarding cycle) so evidence persists
-- across recertification, matching kyc_documents' relationship to customers.
CREATE TYPE lp_evidence_type AS ENUM (
  'mm_otc_licence',
  'incountry_vasp_licence',
  'beneficial_ownership_disclosure',
  'sanctions_pep_attestation',
  'audited_financials',
  'aml_cft_policy',
  'travel_rule_policy',
  'mlro_appointment_letter',
  'market_microstructure_policy',
  'reference_list',
  'insurance_certificate',
  'regulatory_disciplinary_history'
);

CREATE TABLE counterparty_evidence_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id UUID NOT NULL REFERENCES counterparties(id),
  evidence_type lp_evidence_type NOT NULL,
  evidence_uri TEXT NOT NULL,
  note TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX counterparty_evidence_items_counterparty_idx
  ON counterparty_evidence_items (counterparty_id, recorded_at DESC);

-- OM §5.6 Gate G2 (financial soundness — Treasury+Finance), which the
-- generic 'legal'/'technical'/'pilot' gate model has no equivalent for.
-- Reuses counterparty_onboarding_decision since it's the same decision
-- domain, just a different gate; kept as its own table rather than a new
-- value on counterparty_onboarding_gate so it doesn't touch the shared
-- stage-transition logic used by every other counterparty type.
CREATE TABLE counterparty_financial_soundness_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id UUID NOT NULL REFERENCES counterparty_onboardings(id),
  cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
  decision counterparty_onboarding_decision NOT NULL,
  rationale TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_role operating_role NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX counterparty_financial_soundness_decisions_onboarding_idx
  ON counterparty_financial_soundness_decisions (onboarding_id, cycle_number, decided_at DESC);

COMMIT;
