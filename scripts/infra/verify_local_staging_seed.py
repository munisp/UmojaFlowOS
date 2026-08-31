#!/usr/bin/env python3
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path
import psycopg
from psycopg import sql as psql_sql


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument('--database-url', required=True)
    p.add_argument('--manifest', required=True)
    args = p.parse_args()
    manifest = json.loads(Path(args.manifest).read_text())
    assert manifest['scenario_version'] == 'nigeria-cbn-vasp-v1'
    assert manifest['synthetic'] is True
    assert manifest['environment'] == 'local-staging'
    table_names = [item['table'] for item in manifest['tables']]
    assert len(table_names) == len(set(table_names))
    assert manifest['tables']
    assert all(item['row_count'] > 0 for item in manifest['tables'])
    with psycopg.connect(args.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM schema_migrations")
            migrations = cur.fetchone()[0]
            cur.execute("SELECT to_regclass('public.seed_metadata')")
            has_seed_metadata = cur.fetchone()[0] is not None
            if has_seed_metadata:
                cur.execute("SELECT COUNT(*) FROM seed_metadata WHERE scenario_version='nigeria-cbn-vasp-v1'")
                seed_rows = cur.fetchone()[0]
            else:
                seed_rows = None
            cur.execute("SELECT COUNT(*) FROM payment_orders")
            payment_orders = cur.fetchone()[0]
            cur.execute("SELECT COUNT(*) FROM trade_cases")
            trade_cases = cur.fetchone()[0]
            actual_empty_tables = []
            for table_name in table_names:
                schema_name, relation_name = table_name.split('.', 1)
                cur.execute(psql_sql.SQL("SELECT COUNT(*) FROM {}.{}").format(psql_sql.Identifier(schema_name), psql_sql.Identifier(relation_name)))
                if cur.fetchone()[0] == 0:
                    actual_empty_tables.append(table_name)
            checks = {
                'orphan_payment_orders': "SELECT COUNT(*) FROM payment_orders p LEFT JOIN customers c ON c.id=p.customer_id WHERE c.id IS NULL",
                'orphan_trade_cases': "SELECT COUNT(*) FROM trade_cases t LEFT JOIN legal_entities l ON l.id=t.legal_entity_id WHERE l.id IS NULL",
                'invalid_market_observations': "SELECT COUNT(*) FROM market_observations WHERE base_asset=quote_asset OR rate <= 0",
                'invalid_aml_subject_counts': "SELECT COUNT(*) FROM aml_screening_checks WHERE (beneficiary_id IS NOT NULL)::int + (customer_id IS NOT NULL)::int + (payment_order_id IS NOT NULL)::int <> 1",
                'invalid_open_readiness_items': "SELECT COUNT(*) FROM vasp_readiness_assurance_items WHERE status='open' AND (evidence_uri IS NOT NULL OR evidence_sha256 IS NOT NULL OR evidence_recorded_by IS NOT NULL OR evidence_recorded_at IS NOT NULL OR external_verifier IS NOT NULL OR external_attestation_uri IS NOT NULL OR external_attestation_sha256 IS NOT NULL OR verified_by IS NOT NULL OR verified_at IS NOT NULL OR verification_rationale IS NOT NULL OR rejection_rationale IS NOT NULL)",
                'invalid_open_trade_exceptions': "SELECT COUNT(*) FROM trade_case_exceptions WHERE status='open' AND (resolved_by IS NOT NULL OR resolved_at IS NOT NULL OR resolution_rationale IS NOT NULL)",
                'external_execution_assertions': "SELECT COUNT(*) FROM trade_cases WHERE external_execution_initiated OR external_settlement_asserted",
                'submitted_incidents': "SELECT COUNT(*) FROM cbn_sandbox_incidents WHERE notification_status='submitted'",
                'submitted_reporting_packs': "SELECT COUNT(*) FROM cbn_sandbox_reporting_packs WHERE submission_status='submitted'",
            }
            results = {}
            for name, query in checks.items():
                cur.execute(query)
                results[name] = cur.fetchone()[0]
    if actual_empty_tables:
        results['actual_empty_tables'] = actual_empty_tables
    failures = {k: v for k, v in results.items() if v != 0}
    print(json.dumps({'manifest_summary': {'scenario_version': manifest['scenario_version'], 'environment': manifest['environment'], 'synthetic': manifest['synthetic'], 'table_count': len(manifest['tables']), 'generated_at': manifest['generated_at']}, 'migrations': migrations, 'seed_metadata_rows': seed_rows, 'payment_orders': payment_orders, 'trade_cases': trade_cases, 'checks': results, 'status': 'PASS' if not failures else 'FAIL', 'failures': failures}, indent=2, sort_keys=True))
    return 0 if not failures and migrations > 0 and payment_orders > 0 and trade_cases > 0 else 1

if __name__ == '__main__':
    raise SystemExit(main())
