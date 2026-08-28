BEGIN;

-- Enterprise-customer archetype and tier taxonomy (Stakeholder Onboarding OM
-- §4.2 archetypes, §4.3 S1 tier assignment). Nullable: existing customers
-- predate this classification and are not retroactively assigned one.
CREATE TYPE customer_archetype AS ENUM ('importer', 'exporter', 'intercompany_rebalancing', 'payroll_operator');
CREATE TYPE customer_tier AS ENUM ('smb', 'mid', 'enterprise');
CREATE TYPE customer_gate_decision AS ENUM ('approved', 'blocked');

ALTER TABLE customers
  ADD COLUMN archetype customer_archetype,
  ADD COLUMN tier customer_tier,
  ADD COLUMN use_case_narrative TEXT;

-- OM §4.4 evidence item 11/12: the destination-counterparty list a use-case
-- admissibility decision is actually made against.
CREATE TABLE customer_destination_counterparties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  counterparty_name TEXT NOT NULL,
  destination_jurisdiction TEXT NOT NULL,
  invoice_reference TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX customer_destination_counterparties_customer_idx
  ON customer_destination_counterparties (customer_id, created_at DESC);

-- OM §4.6 Gate G1 (use-case admissibility). Append-only decision history,
-- mirroring counterparty_onboarding_gate_decisions: the most recent row is
-- authoritative, prior rows are retained for audit.
CREATE TABLE customer_use_case_gate_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id),
  decision customer_gate_decision NOT NULL,
  rationale TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_role operating_role NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX customer_use_case_gate_decisions_customer_idx
  ON customer_use_case_gate_decisions (customer_id, decided_at DESC);

COMMIT;
