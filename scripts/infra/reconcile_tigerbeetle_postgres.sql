\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE reconciliation_comparison ON COMMIT DROP AS
WITH intents AS (
  SELECT *
  FROM ledger_posting_intents
  WHERE created_at >= :'window_start'::timestamptz
    AND created_at < :'window_end'::timestamptz
    AND intent_state IN ('approved', 'posted')
), facts AS (
  SELECT *
  FROM tigerbeetle_transfer_facts
  WHERE projected_at >= :'window_start'::timestamptz
    AND projected_at < :'window_end'::timestamptz
), matched_by_id AS (
  SELECT i.posting_identity, i.expected_transfer_id, f.tigerbeetle_transfer_id,
    jsonb_build_object('correlation_id', i.correlation_id, 'currency', i.currency,
      'amount_minor', i.amount_minor, 'debit_account_id', i.debit_account_id,
      'credit_account_id', i.credit_account_id) AS expected,
    jsonb_build_object('correlation_id', f.correlation_id, 'currency', f.currency,
      'amount_minor', f.amount_minor, 'debit_account_id', f.debit_account_id,
      'credit_account_id', f.credit_account_id) AS observed,
    CASE WHEN i.correlation_id <> f.correlation_id OR i.currency <> f.currency
      OR i.amount_minor <> f.amount_minor OR i.debit_account_id <> f.debit_account_id
      OR i.credit_account_id <> f.credit_account_id THEN 'field_mismatch' END AS discrepancy_code
  FROM intents i JOIN facts f ON i.expected_transfer_id IS NOT NULL
    AND i.expected_transfer_id = f.tigerbeetle_transfer_id
), matched_by_key AS (
  SELECT i.posting_identity, i.expected_transfer_id, f.tigerbeetle_transfer_id,
    jsonb_build_object('correlation_id', i.correlation_id, 'currency', i.currency,
      'amount_minor', i.amount_minor, 'debit_account_id', i.debit_account_id,
      'credit_account_id', i.credit_account_id) AS expected,
    jsonb_build_object('correlation_id', f.correlation_id, 'currency', f.currency,
      'amount_minor', f.amount_minor, 'debit_account_id', f.debit_account_id,
      'credit_account_id', f.credit_account_id) AS observed,
    NULL::text AS discrepancy_code
  FROM intents i JOIN facts f ON i.expected_transfer_id IS NULL
    AND i.correlation_id = f.correlation_id AND i.currency = f.currency
    AND i.amount_minor = f.amount_minor AND i.debit_account_id = f.debit_account_id
    AND i.credit_account_id = f.credit_account_id
), missing AS (
  SELECT i.posting_identity, i.expected_transfer_id, NULL::bigint AS tigerbeetle_transfer_id,
    jsonb_build_object('correlation_id', i.correlation_id, 'currency', i.currency,
      'amount_minor', i.amount_minor, 'debit_account_id', i.debit_account_id,
      'credit_account_id', i.credit_account_id) AS expected,
    '{}'::jsonb AS observed, 'missing_fact'::text AS discrepancy_code
  FROM intents i
  WHERE NOT EXISTS (SELECT 1 FROM matched_by_id m WHERE m.posting_identity = i.posting_identity)
    AND NOT EXISTS (SELECT 1 FROM matched_by_key m WHERE m.posting_identity = i.posting_identity)
), unexpected AS (
  SELECT NULL::text AS posting_identity, NULL::bigint AS expected_transfer_id,
    f.tigerbeetle_transfer_id, '{}'::jsonb AS expected,
    jsonb_build_object('correlation_id', f.correlation_id, 'currency', f.currency,
      'amount_minor', f.amount_minor, 'debit_account_id', f.debit_account_id,
      'credit_account_id', f.credit_account_id) AS observed,
    'unexpected_fact'::text AS discrepancy_code
  FROM facts f
  WHERE NOT EXISTS (SELECT 1 FROM matched_by_id m WHERE m.tigerbeetle_transfer_id = f.tigerbeetle_transfer_id)
    AND NOT EXISTS (SELECT 1 FROM matched_by_key m WHERE m.tigerbeetle_transfer_id = f.tigerbeetle_transfer_id)
)
SELECT * FROM matched_by_id
UNION ALL SELECT * FROM matched_by_key
UNION ALL SELECT * FROM missing
UNION ALL SELECT * FROM unexpected;

WITH run_counts AS (
  SELECT
    count(*) FILTER (WHERE posting_identity IS NOT NULL) AS intent_count,
    count(*) FILTER (WHERE tigerbeetle_transfer_id IS NOT NULL) AS fact_count,
    count(*) FILTER (WHERE discrepancy_code IS NOT NULL) AS discrepancy_count
  FROM reconciliation_comparison
), inserted_run AS (
  INSERT INTO ledger_reconciliation_runs (
    run_reference, window_start, window_end, status,
    intent_count, fact_count, discrepancy_count, source_identity, completed_at
  )
  SELECT
    :'run_reference', :'window_start'::timestamptz, :'window_end'::timestamptz,
    CASE WHEN discrepancy_count = 0 THEN 'reconciled' ELSE 'discrepancy' END,
    intent_count, fact_count, discrepancy_count, :'source_identity', now()
  FROM run_counts
  RETURNING id
)
INSERT INTO ledger_reconciliation_discrepancies (
  run_id, posting_identity, tigerbeetle_transfer_id,
  discrepancy_code, expected, observed
)
SELECT
  inserted_run.id,
  comparison.posting_identity,
  comparison.tigerbeetle_transfer_id,
  comparison.discrepancy_code,
  comparison.expected,
  comparison.observed
FROM inserted_run
CROSS JOIN reconciliation_comparison comparison
WHERE comparison.discrepancy_code IS NOT NULL;

UPDATE tigerbeetle_transfer_facts fact
SET reconciliation_state = 'reconciled',
    reconciliation_reference = :'run_reference'
WHERE fact.projected_at >= :'window_start'::timestamptz
  AND fact.projected_at < :'window_end'::timestamptz
  AND EXISTS (
    SELECT 1 FROM reconciliation_comparison comparison
    WHERE comparison.tigerbeetle_transfer_id = fact.tigerbeetle_transfer_id
      AND comparison.discrepancy_code IS NULL
  );

UPDATE tigerbeetle_transfer_facts fact
SET reconciliation_state = 'discrepancy',
    reconciliation_reference = :'run_reference'
WHERE fact.projected_at >= :'window_start'::timestamptz
  AND fact.projected_at < :'window_end'::timestamptz
  AND EXISTS (
    SELECT 1 FROM reconciliation_comparison comparison
    WHERE comparison.tigerbeetle_transfer_id = fact.tigerbeetle_transfer_id
      AND comparison.discrepancy_code IS NOT NULL
  );

SELECT run_reference, status, intent_count, fact_count, discrepancy_count
FROM ledger_reconciliation_runs
WHERE run_reference = :'run_reference';

COMMIT;
