# UmojaFlowOS Local Staging Deployment Guide

## Purpose and boundary

This stack provides a reproducible local staging environment for integration tests, synthetic Nigerian scenario data, API demonstrations, and CBN assurance workflow rehearsal. It is not a production deployment and it does not activate provider execution, TigerBeetle posting, live screening, custody, settlement, or regulatory submission.

The stack uses PostgreSQL, Keycloak, Redis, MinIO, OPA, the TypeScript control plane, the Go payment engine, the Rust ledger gateway, the Rust risk-compliance service, and the Python reporting service. All exposed ports bind to `127.0.0.1`.

## Prerequisites

Install Docker Engine with Compose v2, Git, Python 3.11+, and the repository dependencies. Ensure at least 8 GB RAM is available for the multi-service build. Do not use real customer data, real UBO records, provider secrets, production certificates, or live endpoints.

## First startup

```bash
cd /home/ubuntu/UmojaFlowOS
cp infra/local-staging/.env.example infra/local-staging/.env
chmod 600 infra/local-staging/.env
$EDITOR infra/local-staging/.env

# The values must remain local-only and must never be copied to production.
docker compose --env-file infra/local-staging/.env \
  -f infra/local-staging/compose.yaml config >/tmp/umoja-local-staging-rendered.yaml

docker compose --env-file infra/local-staging/.env \
  -f infra/local-staging/compose.yaml up --build -d
```

Check service state:

```bash
docker compose --env-file infra/local-staging/.env \
  -f infra/local-staging/compose.yaml ps
```

Key local endpoints are the control plane on `http://127.0.0.1:3000`, payment engine on `http://127.0.0.1:8081`, risk service on `http://127.0.0.1:8082`, ledger gateway on `http://127.0.0.1:8083`, reporting on `http://127.0.0.1:8084`, Keycloak on `http://127.0.0.1:8088`, MinIO API on `http://127.0.0.1:9000`, and the MinIO console on `http://127.0.0.1:9001`.

## Database setup

The PostgreSQL container executes SQL files mounted from `database/postgresql` on first initialisation. For an already-created volume, apply migrations using the repository migration runner rather than expecting init scripts to run again:

```bash
DATABASE_URL='postgresql://umoja_owner:<local-password>@127.0.0.1:5432/umoja' \
  scripts/infra/apply_postgres_migrations.sh
```

Run schema validation:

```bash
database/postgresql/validate_schema.sql
```

If the schema must be reset, stop the stack and delete only the local named volumes after confirming the target is disposable:

```bash
docker compose --env-file infra/local-staging/.env \
  -f infra/local-staging/compose.yaml down

docker volume ls --format '{{.Name}}' | grep 'umoja' \
  | xargs -r docker volume rm
```

## Synthetic Nigerian scenario data

Use the seeding engine only after migrations have completed:

```bash
python3 scripts/infra/seed_nigeria_scenario.py \
  --database-url 'postgresql://umoja_owner:<local-password>@127.0.0.1:5432/umoja' \
  --environment local-staging \
  --rows-per-table 3 \
  --dry-run \
  --manifest artifacts/local-staging-seed-plan.json
```

Review the plan, then use `--apply` against the disposable database. The resulting records are synthetic fixtures and cannot be used as CBN evidence.

## Smoke tests

```bash
set -euo pipefail
for url in \
  http://127.0.0.1:3000/healthz \
  http://127.0.0.1:8081/healthz \
  http://127.0.0.1:8082/healthz \
  http://127.0.0.1:8083/healthz \
  http://127.0.0.1:8084/healthz; do
  curl --fail --silent --show-error "$url" >/dev/null
  echo "healthy: $url"
done

curl --fail --silent http://127.0.0.1:8088/realms/umojaflowos/.well-known/openid-configuration >/dev/null
```

Run repository checks:

```bash
make check
```

## External-provider substitution

The local stack keeps live execution disabled. A real staging integration requires an approved Keycloak realm, approved AML/sanctions provider, Travel Rule counterparty or written exclusion, provider webhook signing keys, TigerBeetle cluster identity, WORM-compatible evidence store, alert receiver, and named operational owners. Each dependency must be enabled through managed secret references and a reviewed deployment change; no value movement should be enabled by merely changing a boolean.

## Stop and collect logs

```bash
docker compose --env-file infra/local-staging/.env \
  -f infra/local-staging/compose.yaml logs --no-color > artifacts/local-staging-compose.log

docker compose --env-file infra/local-staging/.env \
  -f infra/local-staging/compose.yaml down
```

## Security checklist

Before sharing any output, confirm that logs contain no passwords, tokens, certificates, private keys, real identities, account numbers, provider payloads, or customer documents. Confirm that all provider execution flags remain false and that the stack is bound to loopback. Treat any failed health check or schema migration as a stop condition.
