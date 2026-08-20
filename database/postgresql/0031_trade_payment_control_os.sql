-- Trade-Payment Control OS: a provider-independent evidence and approval layer.
-- These records govern readiness only. They never create a provider instruction,
-- FX order, stablecoin transfer, financing drawdown, custody operation, payment,
-- settlement, or regulatory submission.

BEGIN;

CREATE TABLE trade_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_reference TEXT NOT NULL UNIQUE CHECK (case_reference ~ '^TPC-[A-Z0-9][A-Z0-9-]{5,78}$'),
  legal_entity_id UUID NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  customer_id UUID REFERENCES customers(id) ON DELETE RESTRICT,
  supplier_beneficiary_id UUID REFERENCES beneficiaries(id) ON DELETE RESTRICT,
  corridor corridor_code NOT NULL,
  purchase_currency TEXT NOT NULL CHECK (purchase_currency IN ('NGN','KES','ZAR','USD','USDC','USDT')),
  purchase_amount NUMERIC(30,12) NOT NULL CHECK (purchase_amount > 0),
  intended_settlement_currency TEXT NOT NULL CHECK (intended_settlement_currency IN ('NGN','KES','ZAR','USD','USDC','USDT')),
  purpose_summary TEXT NOT NULL CHECK (char_length(purpose_summary) BETWEEN 16 AND 4000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','evidence_requested','route_readiness','pending_independent_approval','approved_for_authorised_release','blocked','reconciliation_pending','reconciled','cancelled')),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  external_execution_initiated BOOLEAN NOT NULL DEFAULT FALSE CHECK (external_execution_initiated = FALSE),
  external_settlement_asserted BOOLEAN NOT NULL DEFAULT FALSE CHECK (external_settlement_asserted = FALSE)
);

CREATE TABLE trade_case_stakeholders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_case_id UUID NOT NULL REFERENCES trade_cases(id) ON DELETE RESTRICT,
  stakeholder_role TEXT NOT NULL CHECK (stakeholder_role IN ('corporate_trade_sponsor','procurement_owner','trade_finance_operator','supplier_representative','authorised_dealer_liaison','reconciliation_reviewer')),
  stakeholder_subject TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (trade_case_id, stakeholder_role, stakeholder_subject)
);

CREATE TABLE trade_case_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_case_id UUID NOT NULL REFERENCES trade_cases(id) ON DELETE RESTRICT,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('purchase_order','commercial_invoice','supplier_contract','import_trade_document','supplier_kyb','beneficiary_instruction','funding_source','stablecoin_provenance','travel_rule','authorised_dealer_authority','route_capacity_confirmation','provider_authorisation','external_reconciliation_reference')),
  evidence_uri TEXT NOT NULL CHECK (evidence_uri ~ '^https://'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  review_status TEXT NOT NULL DEFAULT 'submitted' CHECK (review_status IN ('submitted','accepted','rejected','replacement_requested')),
  submitted_by TEXT NOT NULL,
  reviewed_by TEXT,
  review_rationale TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  CHECK ((review_status IN ('submitted','replacement_requested') AND reviewed_by IS NULL AND reviewed_at IS NULL) OR (review_status IN ('accepted','rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND review_rationale IS NOT NULL)),
  UNIQUE (trade_case_id, evidence_kind, evidence_sha256)
);

CREATE TABLE trade_case_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_case_id UUID NOT NULL REFERENCES trade_cases(id) ON DELETE RESTRICT,
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE RESTRICT,
  integration_connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE RESTRICT,
  route_kind TEXT NOT NULL CHECK (route_kind IN ('authorised_dealer_fx','bank_supplier_settlement','stablecoin_conversion','supply_chain_finance')),
  source_currency TEXT NOT NULL CHECK (source_currency IN ('NGN','KES','ZAR','USD','USDC','USDT')),
  target_currency TEXT NOT NULL CHECK (target_currency IN ('NGN','KES','ZAR','USD','USDC','USDT')),
  route_policy_evidence_uri TEXT NOT NULL CHECK (route_policy_evidence_uri ~ '^https://'),
  route_policy_evidence_sha256 CHAR(64) NOT NULL CHECK (route_policy_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  readiness_state TEXT NOT NULL DEFAULT 'evidence_pending' CHECK (readiness_state IN ('evidence_pending','pending_compliance_review','approved_for_authorised_release','blocked')),
  configured_by TEXT NOT NULL,
  configured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  external_execution_initiated BOOLEAN NOT NULL DEFAULT FALSE CHECK (external_execution_initiated = FALSE),
  UNIQUE (trade_case_id, counterparty_id, route_kind, source_currency, target_currency)
);

CREATE TABLE trade_case_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_case_id UUID NOT NULL REFERENCES trade_cases(id) ON DELETE RESTRICT,
  approval_role TEXT NOT NULL CHECK (approval_role IN ('corporate_trade_sponsor','procurement_owner','trade_finance_operator','compliance_officer','treasury_operator','reconciliation_reviewer')),
  decision TEXT NOT NULL CHECK (decision IN ('approved','blocked','needs_information')),
  rationale TEXT NOT NULL CHECK (char_length(rationale) BETWEEN 16 AND 4000),
  decided_by TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (trade_case_id, approval_role, decided_by)
);

CREATE TABLE trade_case_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_case_id UUID NOT NULL REFERENCES trade_cases(id) ON DELETE RESTRICT,
  exception_kind TEXT NOT NULL CHECK (exception_kind IN ('documentary_gap','counterparty_scope','route_capacity','beneficiary_change','travel_rule_gap','stablecoin_provenance_gap','policy_conflict','other')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','remediated','rejected')),
  rationale TEXT NOT NULL CHECK (char_length(rationale) BETWEEN 16 AND 4000),
  raised_by TEXT NOT NULL,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  resolution_rationale TEXT,
  CHECK ((status = 'open' AND resolved_by IS NULL AND resolved_at IS NULL) OR (status IN ('remediated','rejected') AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolution_rationale IS NOT NULL))
);

CREATE TABLE trade_case_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_case_id UUID NOT NULL REFERENCES trade_cases(id) ON DELETE RESTRICT,
  reference_kind TEXT NOT NULL CHECK (reference_kind IN ('provider_confirmation','bank_reference','supplier_receipt','trade_finance_reference','stablecoin_attestation')),
  reference_uri TEXT NOT NULL CHECK (reference_uri ~ '^https://'),
  reference_sha256 CHAR(64) NOT NULL CHECK (reference_sha256 ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('recorded','consistent','discrepant')),
  reviewed_by TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  external_settlement_asserted BOOLEAN NOT NULL DEFAULT FALSE CHECK (external_settlement_asserted = FALSE),
  UNIQUE (trade_case_id, reference_kind, reference_sha256)
);

CREATE INDEX trade_cases_status_corridor_idx ON trade_cases (status, corridor, created_at DESC);
CREATE INDEX trade_case_stakeholders_subject_idx ON trade_case_stakeholders (stakeholder_subject, trade_case_id) WHERE revoked_at IS NULL;
CREATE INDEX trade_case_evidence_lookup_idx ON trade_case_evidence (trade_case_id, review_status, evidence_kind);
CREATE INDEX trade_case_routes_readiness_idx ON trade_case_routes (trade_case_id, readiness_state);
CREATE INDEX trade_case_approvals_lookup_idx ON trade_case_approvals (trade_case_id, approval_role, decided_at DESC);
CREATE INDEX trade_case_exceptions_lookup_idx ON trade_case_exceptions (trade_case_id, status, raised_at DESC);
CREATE INDEX trade_case_reconciliations_lookup_idx ON trade_case_reconciliations (trade_case_id, status, reviewed_at DESC);

COMMIT;
