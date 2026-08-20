-- Provider-independent enterprise governance modules. These records govern
-- evidence, limits, review, and activation readiness only. They cannot create
-- a bank instruction, FX order, custody operation, stablecoin transfer,
-- financing, lending, card issuance, payment, charge, or settlement.

BEGIN;

CREATE TABLE governed_bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id UUID NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE RESTRICT,
  integration_connection_id UUID REFERENCES integration_connections(id) ON DELETE RESTRICT,
  country_code CHAR(2) NOT NULL CHECK (country_code IN ('NG','KE','ZA')),
  currency TEXT NOT NULL CHECK (currency IN ('NGN','KES','ZAR','USD','USDC','USDT')),
  account_reference_hash CHAR(64) NOT NULL CHECK (account_reference_hash ~ '^[a-f0-9]{64}$'),
  mandate_evidence_uri TEXT NOT NULL CHECK (mandate_evidence_uri ~ '^https://'),
  mandate_evidence_sha256 CHAR(64) NOT NULL CHECK (mandate_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'evidence_pending' CHECK (status IN ('evidence_pending','reviewed','blocked','approved_for_authorised_path')),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  bank_instruction_initiated BOOLEAN NOT NULL DEFAULT FALSE CHECK (bank_instruction_initiated = FALSE),
  UNIQUE (legal_entity_id, counterparty_id, currency, account_reference_hash)
);

CREATE TABLE liquidity_governance_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id UUID NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  country_code CHAR(2) NOT NULL CHECK (country_code IN ('NG','KE','ZA')),
  currency TEXT NOT NULL CHECK (currency IN ('NGN','KES','ZAR','USD','USDC','USDT')),
  concentration_limit_percent NUMERIC(5,2) NOT NULL CHECK (concentration_limit_percent > 0 AND concentration_limit_percent <= 100),
  approval_threshold_amount NUMERIC(30,12) NOT NULL CHECK (approval_threshold_amount > 0),
  policy_evidence_uri TEXT NOT NULL CHECK (policy_evidence_uri ~ '^https://'),
  policy_evidence_sha256 CHAR(64) NOT NULL CHECK (policy_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','approved','blocked')),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, country_code, currency, policy_evidence_sha256)
);

CREATE TABLE stablecoin_treasury_mandates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id UUID NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  corridor corridor_code NOT NULL,
  asset TEXT NOT NULL CHECK (asset IN ('USDC','USDT')),
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE RESTRICT,
  integration_connection_id UUID REFERENCES integration_connections(id) ON DELETE RESTRICT,
  maximum_exposure NUMERIC(30,12) NOT NULL CHECK (maximum_exposure > 0),
  requires_travel_rule BOOLEAN NOT NULL DEFAULT TRUE,
  requires_beneficiary_evidence BOOLEAN NOT NULL DEFAULT TRUE,
  mandate_evidence_uri TEXT NOT NULL CHECK (mandate_evidence_uri ~ '^https://'),
  mandate_evidence_sha256 CHAR(64) NOT NULL CHECK (mandate_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'evidence_pending' CHECK (status IN ('evidence_pending','reviewed','approved_for_authorised_path','blocked')),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  custody_operation_initiated BOOLEAN NOT NULL DEFAULT FALSE CHECK (custody_operation_initiated = FALSE),
  stablecoin_transfer_initiated BOOLEAN NOT NULL DEFAULT FALSE CHECK (stablecoin_transfer_initiated = FALSE),
  UNIQUE (legal_entity_id, corridor, asset, counterparty_id, mandate_evidence_sha256)
);

CREATE TABLE supply_chain_finance_programmes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id UUID NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  funder_counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE RESTRICT,
  integration_connection_id UUID REFERENCES integration_connections(id) ON DELETE RESTRICT,
  supplier_beneficiary_id UUID REFERENCES beneficiaries(id) ON DELETE RESTRICT,
  programme_reference TEXT NOT NULL UNIQUE CHECK (programme_reference ~ '^SCF-[A-Z0-9][A-Z0-9-]{5,78}$'),
  receivable_evidence_uri TEXT NOT NULL CHECK (receivable_evidence_uri ~ '^https://'),
  receivable_evidence_sha256 CHAR(64) NOT NULL CHECK (receivable_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  programme_policy_uri TEXT NOT NULL CHECK (programme_policy_uri ~ '^https://'),
  programme_policy_sha256 CHAR(64) NOT NULL CHECK (programme_policy_sha256 ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'evidence_pending' CHECK (status IN ('evidence_pending','reviewed','offer_evidence_recorded','blocked')),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  credit_decision_made BOOLEAN NOT NULL DEFAULT FALSE CHECK (credit_decision_made = FALSE),
  funding_initiated BOOLEAN NOT NULL DEFAULT FALSE CHECK (funding_initiated = FALSE),
  disbursement_initiated BOOLEAN NOT NULL DEFAULT FALSE CHECK (disbursement_initiated = FALSE)
);

CREATE TABLE spend_card_programmes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id UUID NOT NULL REFERENCES legal_entities(id) ON DELETE RESTRICT,
  counterparty_id UUID NOT NULL REFERENCES counterparties(id) ON DELETE RESTRICT,
  integration_connection_id UUID REFERENCES integration_connections(id) ON DELETE RESTRICT,
  programme_reference TEXT NOT NULL UNIQUE CHECK (programme_reference ~ '^SCP-[A-Z0-9][A-Z0-9-]{5,78}$'),
  country_code CHAR(2) NOT NULL CHECK (country_code IN ('NG','KE','ZA')),
  currency TEXT NOT NULL CHECK (currency IN ('NGN','KES','ZAR','USD')),
  programme_evidence_uri TEXT NOT NULL CHECK (programme_evidence_uri ~ '^https://'),
  programme_evidence_sha256 CHAR(64) NOT NULL CHECK (programme_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'evidence_pending' CHECK (status IN ('evidence_pending','reviewed','approved_for_authorised_path','blocked')),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  card_issued BOOLEAN NOT NULL DEFAULT FALSE CHECK (card_issued = FALSE),
  card_authorisation_initiated BOOLEAN NOT NULL DEFAULT FALSE CHECK (card_authorisation_initiated = FALSE),
  charge_or_settlement_initiated BOOLEAN NOT NULL DEFAULT FALSE CHECK (charge_or_settlement_initiated = FALSE)
);

CREATE TABLE spend_policy_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spend_card_programme_id UUID NOT NULL REFERENCES spend_card_programmes(id) ON DELETE RESTRICT,
  rule_kind TEXT NOT NULL CHECK (rule_kind IN ('category','per_transaction_limit','period_limit','employee_eligibility','receipt_requirement')),
  rule_value JSONB NOT NULL,
  evidence_uri TEXT NOT NULL CHECK (evidence_uri ~ '^https://'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (spend_card_programme_id, rule_kind, evidence_sha256)
);

CREATE TABLE enterprise_governance_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_kind TEXT NOT NULL CHECK (module_kind IN ('multi_bank_treasury','stablecoin_treasury','supply_chain_finance','spend_card_programme')),
  subject_id UUID NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','blocked','needs_information')),
  rationale TEXT NOT NULL CHECK (char_length(rationale) BETWEEN 16 AND 4000),
  decided_by TEXT NOT NULL,
  decided_role TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  external_execution_initiated BOOLEAN NOT NULL DEFAULT FALSE CHECK (external_execution_initiated = FALSE)
);

CREATE INDEX governed_bank_accounts_entity_status_idx ON governed_bank_accounts (legal_entity_id, status, recorded_at DESC);
CREATE INDEX liquidity_governance_policies_entity_status_idx ON liquidity_governance_policies (legal_entity_id, status, recorded_at DESC);
CREATE INDEX stablecoin_treasury_mandates_entity_status_idx ON stablecoin_treasury_mandates (legal_entity_id, status, recorded_at DESC);
CREATE INDEX supply_chain_finance_programmes_entity_status_idx ON supply_chain_finance_programmes (legal_entity_id, status, recorded_at DESC);
CREATE INDEX spend_card_programmes_entity_status_idx ON spend_card_programmes (legal_entity_id, status, recorded_at DESC);
CREATE INDEX enterprise_governance_reviews_subject_idx ON enterprise_governance_reviews (module_kind, subject_id, decided_at DESC);

COMMIT;
