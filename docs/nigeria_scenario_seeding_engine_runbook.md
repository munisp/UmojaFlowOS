# Nigerian Scenario Seeding Engine Runbook

## Purpose

`scripts/infra/seed_nigeria_scenario.py` creates deterministic, synthetic records for local or approved disposable staging databases. It introspects PostgreSQL at runtime and includes every base table in the selected schema without a hand-maintained table list.

The values are Nigerian-scenario anchors: `NG`, `NGN`, Nigerian cities and states, bounded transaction amounts, synthetic CBN Cohort 2 and VASP labels, and explicit synthetic evidence text. They are not real customer, UBO, sanctions, provider, regulatory, or production financial records.

## Safety properties

The engine refuses `production`, `prod`, and `live` environments. It refuses destructive truncation. It requires an explicit `--dry-run` or `--apply`. It writes a JSON manifest describing every planned or applied row. It excludes identity/generated columns and common database-generated defaults. It uses PostgreSQL only and has no Manus, cloud-vendor, or external-network dependency.

The engine fails closed on insert errors. It does not disable foreign keys, triggers, row-level security, or audit hooks. Apply only to a disposable or explicitly approved environment whose schema and constraints have been reviewed.

## Install dependency

Use the repository’s approved Python environment and install `psycopg[binary]` according to the project dependency policy. Do not install packages globally on a production host.

## Dry-run

```bash
cd /home/ubuntu/UmojaFlowOS
export DATABASE_URL='postgresql://seed_user:password@localhost:5432/umoja_staging?sslmode=verify-full&sslrootcert=/run/secrets/ca.pem'

python3 scripts/infra/seed_nigeria_scenario.py \
  --database-url "$DATABASE_URL" \
  --environment staging-disposable \
  --schema public \
  --rows-per-table 3 \
  --dry-run \
  --manifest artifacts/nigeria-seed-dry-run.json
```

Review the manifest, especially table count, nullable handling, generated-column exclusion, and business-sensitive fields. The manifest itself is synthetic test evidence only.

## Apply to a disposable database

```bash
python3 scripts/infra/seed_nigeria_scenario.py \
  --database-url "$DATABASE_URL" \
  --environment staging-disposable \
  --schema public \
  --rows-per-table 3 \
  --apply \
  --manifest artifacts/nigeria-seed-applied.json
```

After applying, run the repository migration/schema validation and the relevant service tests. Inspect row counts and verify that no real records are present.

## Verification queries

```sql
SELECT table_name, table_type
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;

SELECT table_name, COUNT(*)
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
GROUP BY table_name
ORDER BY table_name;
```

Use the JSON manifest to compare planned and applied row counts. Search for accidental non-synthetic values before any environment is shared:

```bash
grep -RInE 'synthetic|example\.invalid|synthetic\.umoja\.invalid' artifacts/nigeria-seed-*.json
```

## Important limitation

A generic runtime seeder can discover every table, but it cannot infer every business invariant, foreign-key relationship, enum domain, tenant policy, or required cross-table lifecycle from column names alone. Therefore, the engine is intentionally strict: if an insert violates a database constraint, it stops rather than bypassing controls. Domain-specific fixture builders should be added only for approved test scenarios and must preserve the same synthetic-data and non-production restrictions.

## What this engine must never seed

It must never seed real names, identity numbers, BVNs, account numbers, UBO records, sanctions data, provider credentials, customer documents, private keys, production evidence, regulatory submissions, or live payment events. Use anonymised fixtures and controlled test identifiers instead.
