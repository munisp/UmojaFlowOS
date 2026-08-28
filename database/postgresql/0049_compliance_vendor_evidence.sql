BEGIN;

-- OM §9.2 names five vendor archetypes, but the canonical counterparty_type
-- check constraint only had matches for three of them (kyc_provider,
-- sanctions_provider, chain_analytics_provider). Travel-Rule vendors and
-- adverse-media vendors have no existing type, so this extends the
-- constraint rather than shoehorning them into an ill-fitting value.
ALTER TABLE counterparties DROP CONSTRAINT counterparties_counterparty_type_check;
ALTER TABLE counterparties ADD CONSTRAINT counterparties_counterparty_type_check
  CHECK (counterparty_type = ANY (ARRAY[
    'licensed_psp'::text, 'correspondent_bank'::text, 'stablecoin_provider'::text, 'fx_liquidity_provider'::text,
    'custody_provider'::text, 'kyc_provider'::text, 'sanctions_provider'::text, 'chain_analytics_provider'::text,
    'notification_provider'::text, 'regulatory_submission_provider'::text,
    'travel_rule_provider'::text, 'adverse_media_provider'::text
  ]));

-- OM §9.2 archetype taxonomy for compliance & risk vendors.
CREATE TYPE compliance_vendor_archetype AS ENUM ('kyc_kyb_platform', 'sanctions_screening', 'chain_analytics', 'travel_rule_vendor', 'adverse_media');

ALTER TABLE counterparties
  ADD COLUMN compliance_vendor_archetype compliance_vendor_archetype;

-- OM §9.4's 10-item vendor evidence pack.
CREATE TYPE compliance_vendor_evidence_type AS ENUM (
  'soc2_or_iso27001_report',
  'information_security_policy',
  'privacy_policy_dpa_template',
  'penetration_test_summary',
  'insurance_certificate',
  'beneficial_ownership_disclosure',
  'vendor_sanctions_compliance_posture',
  'list_data_sourcing_summary',
  'sub_processor_list',
  'sla_template_uptime_commitment'
);

CREATE TABLE compliance_vendor_evidence_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id UUID NOT NULL REFERENCES counterparties(id),
  evidence_type compliance_vendor_evidence_type NOT NULL,
  evidence_uri TEXT NOT NULL,
  note TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX compliance_vendor_evidence_items_counterparty_idx
  ON compliance_vendor_evidence_items (counterparty_id, recorded_at DESC);

-- OM §9.6 defines four vendor-specific gates (G1 security posture, G2
-- coverage feasibility, G3 false-positive ceiling, G4 annual review) whose
-- pass criteria -- SOC 2/pen-test currency, coverage drilldown across named
-- sanctions lists, a false-positive benchmark, an annual no-gap review --
-- have no equivalent in the shared legal/technical/pilot lifecycle, so all
-- four live here rather than reusing counterparty_onboarding_gate_decisions,
-- matching the treatment used for payout PSPs (Ch.7) and stablecoin issuers
-- (Ch.8).
CREATE TYPE compliance_vendor_gate AS ENUM ('security_posture', 'coverage_feasibility', 'false_positive_ceiling', 'annual_review');

CREATE TABLE compliance_vendor_gate_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id UUID NOT NULL REFERENCES counterparty_onboardings(id),
  cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
  gate compliance_vendor_gate NOT NULL,
  decision counterparty_onboarding_decision NOT NULL,
  rationale TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_role operating_role NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX compliance_vendor_gate_decisions_onboarding_idx
  ON compliance_vendor_gate_decisions (onboarding_id, cycle_number, gate, decided_at DESC);

COMMIT;
