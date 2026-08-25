-- 0042_tigerbeetle_postgres_reconciliation.sql
-- Canonical PostgreSQL reconciliation evidence for TigerBeetle postings.
-- This records intent and comparison outcomes; it never asserts settlement by itself.
BEGIN;

CREATE TABLE ledger_posting_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  posting_identity TEXT NOT NULL UNIQUE,
  correlation_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('NGN', 'KES', 'ZAR', 'USD', 'USDC', 'USDT')),
  amount_minor NUMERIC(30, 0) NOT NULL CHECK (amount_minor > 0),
  debit_account_id BIGINT NOT NULL REFERENCES ledger_account_bindings(tigerbeetle_account_id),
  credit_account_id BIGINT NOT NULL REFERENCES ledger_account_bindings(tigerbeetle_account_id),
  expected_transfer_id BIGINT UNIQUE CHECK (expected_transfer_id IS NULL OR expected_transfer_id > 0),
  intent_state TEXT NOT NULL DEFAULT 'approved' CHECK (intent_state IN ('approved', 'posted', 'voided', 'blocked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (debit_account_id <> credit_account_id)
);

CREATE TABLE ledger_reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_reference TEXT NOT NULL UNIQUE,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reconciled', 'discrepancy', 'indeterminate')),
  intent_count BIGINT NOT NULL CHECK (intent_count >= 0),
  fact_count BIGINT NOT NULL CHECK (fact_count >= 0),
  discrepancy_count BIGINT NOT NULL CHECK (discrepancy_count >= 0),
  source_identity TEXT NOT NULL,
  error_summary TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CHECK (window_end > window_start),
  CHECK ((status = 'reconciled' AND discrepancy_count = 0 AND error_summary IS NULL)
      OR (status = 'discrepancy' AND discrepancy_count > 0 AND error_summary IS NULL)
      OR (status = 'indeterminate' AND error_summary IS NOT NULL AND length(trim(error_summary)) >= 8))
);

CREATE TABLE ledger_reconciliation_discrepancies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES ledger_reconciliation_runs(id) ON DELETE RESTRICT,
  posting_identity TEXT,
  tigerbeetle_transfer_id BIGINT,
  discrepancy_code TEXT NOT NULL CHECK (discrepancy_code IN ('missing_fact', 'unexpected_fact', 'field_mismatch', 'duplicate_identity', 'invalid_balance')),
  expected JSONB,
  observed JSONB,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_posting_intents_window_idx ON ledger_posting_intents (created_at, intent_state);
CREATE INDEX ledger_reconciliation_runs_status_idx ON ledger_reconciliation_runs (status, completed_at DESC);
CREATE INDEX ledger_reconciliation_discrepancies_run_idx ON ledger_reconciliation_discrepancies (run_id, discrepancy_code);

REVOKE ALL ON ledger_posting_intents, ledger_reconciliation_runs, ledger_reconciliation_discrepancies FROM PUBLIC;

COMMIT;
