\set ON_ERROR_STOP on
\pset pager off
\echo '--- migration ledger ---'
SELECT COUNT(*) AS applied_migrations FROM schema_migrations;
SELECT version, checksum FROM schema_migrations ORDER BY version;
\echo '--- populated public tables ---'
SELECT COUNT(*) AS populated_tables
FROM (
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema='public' AND table_type='BASE TABLE'
) t
WHERE EXISTS (
  SELECT 1 FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname=t.table_name AND c.reltuples >= 0
);
SELECT format('SELECT %L AS table_name, count(*) AS row_count FROM public.%I;', table_name, table_name)
FROM information_schema.tables
WHERE table_schema='public' AND table_type='BASE TABLE'
ORDER BY table_name;
\echo '--- core integrity checks ---'
SELECT COUNT(*) AS orphan_payment_orders
FROM payment_orders p
LEFT JOIN customers c ON c.id=p.customer_id
WHERE c.id IS NULL;
SELECT COUNT(*) AS orphan_trade_cases
FROM trade_cases t
LEFT JOIN legal_entities l ON l.id=t.legal_entity_id
WHERE l.id IS NULL;
SELECT COUNT(*) AS invalid_market_observations
FROM market_observations
WHERE base_asset=quote_asset OR rate <= 0;
SELECT COUNT(*) AS invalid_aml_subject_counts
FROM aml_screening_checks
WHERE (beneficiary_id IS NOT NULL)::int + (customer_id IS NOT NULL)::int + (payment_order_id IS NOT NULL)::int <> 1;
SELECT COUNT(*) AS invalid_open_readiness_items
FROM vasp_readiness_assurance_items
WHERE status='open' AND (
  evidence_uri IS NOT NULL OR evidence_sha256 IS NOT NULL OR evidence_recorded_by IS NOT NULL OR
  evidence_recorded_at IS NOT NULL OR external_verifier IS NOT NULL OR external_attestation_uri IS NOT NULL OR
  external_attestation_sha256 IS NOT NULL OR verified_by IS NOT NULL OR verified_at IS NOT NULL OR
  verification_rationale IS NOT NULL OR rejection_rationale IS NOT NULL
);
SELECT COUNT(*) AS invalid_open_trade_exceptions
FROM trade_case_exceptions
WHERE status='open' AND (resolved_by IS NOT NULL OR resolved_at IS NOT NULL OR resolution_rationale IS NOT NULL);
SELECT COUNT(*) AS external_execution_assertions
FROM trade_cases
WHERE external_execution_initiated OR external_settlement_asserted;
SELECT COUNT(*) AS submitted_cbn_records
FROM cbn_sandbox_incidents
WHERE notification_status='submitted'
UNION ALL
SELECT COUNT(*) FROM cbn_sandbox_reporting_packs WHERE submission_status='submitted';
\echo '--- seed metadata ---'
SELECT COUNT(*) AS synthetic_seed_rows FROM seed_metadata WHERE scenario_version='nigeria-cbn-vasp-v1';
