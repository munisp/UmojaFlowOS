-- Durable P0 control evidence for TigerBeetle facts, live AML/CFT screening,
-- provider Send requests, and authorised regulatory-channel submissions.
-- These tables intentionally distinguish a provider or channel acknowledgement
-- from settlement, licence, or supervisory approval.

BEGIN;

CREATE TABLE ledger_account_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_reference TEXT NOT NULL UNIQUE,
  tigerbeetle_account_id BIGINT NOT NULL UNIQUE CHECK (tigerbeetle_account_id > 0),
  account_kind TEXT NOT NULL CHECK (account_kind IN ('customer_safeguarded', 'settlement_asset', 'provider_clearing', 'fee_revenue')),
  currency TEXT NOT NULL CHECK (currency IN ('NGN', 'KES', 'ZAR', 'USD', 'USDC', 'USDT')),
  evidence_uri TEXT NOT NULL CHECK (evidence_uri ~ '^https://'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tigerbeetle_transfer_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tigerbeetle_transfer_id BIGINT NOT NULL UNIQUE CHECK (tigerbeetle_transfer_id > 0),
  correlation_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('NGN', 'KES', 'ZAR', 'USD', 'USDC', 'USDT')),
  amount_minor NUMERIC(30, 0) NOT NULL CHECK (amount_minor > 0),
  debit_account_id BIGINT NOT NULL REFERENCES ledger_account_bindings(tigerbeetle_account_id),
  credit_account_id BIGINT NOT NULL REFERENCES ledger_account_bindings(tigerbeetle_account_id),
  posted_at TIMESTAMPTZ NOT NULL,
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  projected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reconciliation_state TEXT NOT NULL DEFAULT 'pending' CHECK (reconciliation_state IN ('pending', 'reconciled', 'discrepancy')),
  reconciliation_reference TEXT,
  CHECK (debit_account_id <> credit_account_id),
  CHECK ((reconciliation_state = 'reconciled' AND reconciliation_reference IS NOT NULL) OR reconciliation_state <> 'reconciled')
);

CREATE TABLE aml_screening_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beneficiary_id UUID REFERENCES beneficiaries(id) ON DELETE RESTRICT,
  customer_id UUID REFERENCES customers(id) ON DELETE RESTRICT,
  payment_order_id UUID REFERENCES payment_orders(id) ON DELETE RESTRICT,
  integration_connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE RESTRICT,
  correlation_id TEXT NOT NULL,
  screening_scope TEXT NOT NULL CHECK (screening_scope IN ('beneficiary', 'customer', 'payment', 'counterparty')),
  screening_state screening_state NOT NULL,
  provider_reference TEXT NOT NULL,
  source_version TEXT NOT NULL,
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  screened_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(beneficiary_id, customer_id, payment_order_id) = 1),
  UNIQUE (integration_connection_id, provider_reference)
);

CREATE TABLE provider_send_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_order_id UUID NOT NULL REFERENCES payment_orders(id) ON DELETE RESTRICT,
  payment_leg_id UUID NOT NULL REFERENCES payment_legs(id) ON DELETE RESTRICT,
  integration_connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE RESTRICT,
  provider_reference TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finality_state TEXT NOT NULL DEFAULT 'provider_pending' CHECK (finality_state IN ('provider_pending', 'webhook_confirmed', 'reconciliation_pending', 'reconciled', 'failed', 'discrepancy')),
  provider_finality_reference TEXT,
  reconciliation_reference TEXT,
  CHECK ((finality_state = 'reconciled' AND reconciliation_reference IS NOT NULL) OR finality_state <> 'reconciled'),
  UNIQUE (payment_leg_id, provider_reference)
);

CREATE TABLE regulatory_submission_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  regulatory_report_id UUID NOT NULL REFERENCES regulatory_reports(id) ON DELETE RESTRICT,
  integration_connection_id UUID NOT NULL REFERENCES integration_connections(id) ON DELETE RESTRICT,
  channel_reference TEXT NOT NULL,
  request_sha256 CHAR(64) NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  attempt_state TEXT NOT NULL CHECK (attempt_state IN ('prepared', 'submitted', 'accepted', 'rejected', 'unavailable')),
  external_reference TEXT,
  submitted_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_evidence_sha256 CHAR(64),
  CHECK ((attempt_state IN ('submitted', 'accepted', 'rejected') AND external_reference IS NOT NULL AND submitted_at IS NOT NULL) OR attempt_state IN ('prepared', 'unavailable')),
  UNIQUE (regulatory_report_id, request_sha256)
);

CREATE INDEX tigerbeetle_transfer_facts_correlation_idx
  ON tigerbeetle_transfer_facts (correlation_id, projected_at DESC);
CREATE INDEX aml_screening_checks_subject_idx
  ON aml_screening_checks (beneficiary_id, customer_id, payment_order_id, screened_at DESC);
CREATE INDEX provider_send_requests_order_idx
  ON provider_send_requests (payment_order_id, accepted_at DESC);
CREATE INDEX regulatory_submission_attempts_report_idx
  ON regulatory_submission_attempts (regulatory_report_id, recorded_at DESC);

COMMIT;
