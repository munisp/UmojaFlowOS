BEGIN;

-- OM §7.2 archetype taxonomy for payout PSPs / mobile-money operators.
CREATE TYPE psp_archetype AS ENUM ('bank_instant_rail', 'mobile_money', 'virtual_card_issuer', 'otc_cash_pickup', 'aggregator_psp');

ALTER TABLE counterparties
  ADD COLUMN psp_archetype psp_archetype;

-- OM §7.4's 12-item payout-PSP evidence pack.
CREATE TYPE psp_evidence_type AS ENUM (
  'psp_licence',
  'mobile_money_authorisation',
  'aggregator_licence',
  'sanctions_pep_attestation',
  'aml_cft_policy',
  'beneficial_ownership_disclosure',
  'cutoff_settlement_calendar',
  'fee_schedule_fx_margin',
  'reconciliation_file_format_spec',
  'dispute_recall_channel_sla',
  'audited_financials',
  'cyber_bcp_attestation'
);

CREATE TABLE psp_evidence_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id UUID NOT NULL REFERENCES counterparties(id),
  evidence_type psp_evidence_type NOT NULL,
  evidence_uri TEXT NOT NULL,
  note TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX psp_evidence_items_counterparty_idx
  ON psp_evidence_items (counterparty_id, recorded_at DESC);

-- OM §7.6 defines four gates (G1 licence+rail coverage, G2 settlement+cutoff
-- validation, G3 bounded-live, G4 failover rail) that are ALL payout-PSP
-- specific -- unlike LP/Bank, none of them map onto the shared generic
-- legal/technical/pilot lifecycle, so all four live here rather than
-- reusing counterparty_onboarding_gate_decisions. Every gate owner in the OM
-- is "Operations" (paired with Compliance, Treasury, or Country Lead) but
-- this platform has no distinct Operations or Country Lead role; the
-- closest-match restriction per gate is enforced in application code and
-- disclosed in the UI, not silently substituted.
CREATE TYPE psp_gate AS ENUM ('licence_rail_coverage', 'settlement_cutoff_validation', 'bounded_live', 'failover_rail');

CREATE TABLE psp_gate_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id UUID NOT NULL REFERENCES counterparty_onboardings(id),
  cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
  gate psp_gate NOT NULL,
  decision counterparty_onboarding_decision NOT NULL,
  rationale TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_role operating_role NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX psp_gate_decisions_onboarding_idx
  ON psp_gate_decisions (onboarding_id, cycle_number, gate, decided_at DESC);

COMMIT;
