CREATE TYPE counterparty_onboarding_stage AS ENUM (
  'legal_onboarding',
  'technical_readiness',
  'pilot',
  'steady_state',
  'recertification_due',
  'blocked'
);

CREATE TYPE counterparty_onboarding_gate AS ENUM ('legal', 'technical', 'pilot');
CREATE TYPE counterparty_onboarding_decision AS ENUM ('approved', 'blocked');

CREATE TABLE counterparty_onboardings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id UUID NOT NULL UNIQUE REFERENCES counterparties(id),
  country_overlays corridor_code[] NOT NULL,
  stage counterparty_onboarding_stage NOT NULL DEFAULT 'legal_onboarding',
  cycle_number INTEGER NOT NULL DEFAULT 1 CHECK (cycle_number > 0),
  legal_evidence_uri TEXT NOT NULL,
  technical_evidence_uri TEXT,
  pilot_evidence_uri TEXT,
  recertification_due_at TIMESTAMPTZ,
  current_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (cardinality(country_overlays) BETWEEN 1 AND 3)
);

CREATE TABLE counterparty_onboarding_gate_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  onboarding_id UUID NOT NULL REFERENCES counterparty_onboardings(id),
  cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
  gate counterparty_onboarding_gate NOT NULL,
  decision counterparty_onboarding_decision NOT NULL,
  evidence_uri TEXT NOT NULL,
  rationale TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_role operating_role NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (onboarding_id, cycle_number, gate, decided_role)
);

CREATE INDEX counterparty_onboardings_stage_due_idx
  ON counterparty_onboardings (stage, recertification_due_at);
CREATE INDEX counterparty_onboarding_gate_decisions_lookup_idx
  ON counterparty_onboarding_gate_decisions (onboarding_id, cycle_number, gate, decided_at);
