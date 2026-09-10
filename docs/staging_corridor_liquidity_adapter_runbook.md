# Staging Runbook: Corridor Liquidity Adapter

## Purpose

This runbook applies migration `0061_corridor_liquidity_policy.sql` and enables the PostgreSQL-authoritative `PostgresRedisLiquidityVerifier` in the payment engine. The adapter must be enabled only after the database migration, Redis connectivity, tenant isolation, OTel telemetry, and concurrent fail-closed tests pass.

## Preconditions

The staging operator must have:

| Requirement | Acceptance condition |
|---|---|
| PostgreSQL 16 | Reachable through the schema-owner migration connection and the application connection. |
| Redis 7 or compatible | TLS/authentication configured where required; `PING` succeeds from the payment-engine namespace. |
| Schema-owner identity | Separate from `umoja_app`; application role has no DDL privileges. |
| Immutable release | Image digest and four-role release evidence already pass the release gate. |
| OTel Collector | OTLP endpoint reachable and Prometheus exporter scrape target healthy. |
| Backup | PostgreSQL backup completed and migration rollback/forward plan approved. |

The migration is tenant-sensitive. Do not apply it with the application role.

## 1. Verify target and credentials

```bash
export STAGING_DATABASE_URL='postgres://assurance_schema_owner:${SCHEMA_OWNER_PASSWORD}@postgres.staging:5432/umoja?sslmode=verify-full'
export APP_DATABASE_URL='postgres://umoja_app:${APP_PASSWORD}@postgres.staging:5432/umoja?sslmode=verify-full'
export REDIS_URL='rediss://:${REDIS_PASSWORD}@redis.staging:6380/0'
export TENANT_ID='tenant-a'

psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'select current_user, current_database();'
psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 -c 'select current_user, current_database();'
redis-cli --tls -u "$REDIS_URL" PING
```

The migration must stop if the schema-owner connection is not active or if the Redis health check fails.

## 2. Apply migration 0061

```bash
cd /home/ubuntu/UmojaFlowOS-repo

psql "$STAGING_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -f database/postgresql/0061_corridor_liquidity_policy.sql
```

Verify objects and policies:

```bash
psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
select to_regclass('public.corridor_routes');
select to_regclass('public.liquidity_treasury_evidence');
select relrowsecurity
from pg_class
where oid in ('public.corridor_routes'::regclass,
              'public.liquidity_treasury_evidence'::regclass);

select policyname, tablename
from pg_policies
where tablename in ('corridor_routes', 'liquidity_treasury_evidence')
order by tablename, policyname;
SQL
```

Verify application-role DDL boundaries:

```bash
psql "$APP_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
select has_table_privilege(current_user, 'public.corridor_routes', 'INSERT') as can_insert,
       has_table_privilege(current_user, 'public.corridor_routes', 'UPDATE') as can_update,
       has_table_privilege(current_user, 'public.corridor_routes', 'DELETE') as can_delete;
SQL
```

The application role may receive controlled DML privileges according to the repository grant policy, but must not own the tables or execute DDL.

## 3. Seed an approved route and signed liquidity evidence

Route and evidence writes must run through the approved control-plane/schema-owner process. A minimum staging fixture is:

```sql
insert into corridor_routes (
  route_id, tenant_id, origin_country, destination_country,
  source_currency, destination_currency, direction, asset,
  rails, provider_priority, min_amount_minor, max_amount_minor,
  quote_ttl_seconds, liquidity_buffer_bps, enabled, version
) values (
  'ng-onramp', 'tenant-a', 'US', 'NG',
  'NGN', 'USDC', 'onramp', 'USDC',
  '["mojaloop", "bank-primary"]'::jsonb,
  '["bank-primary", "bank-secondary"]'::jsonb,
  1, 100000000, 300, 100, true, 1
);

insert into liquidity_treasury_evidence (
  evidence_id, tenant_id, route_id, provider, currency,
  available_minor, reserved_minor, required_buffer_minor,
  observed_at, expires_at, source, evidence_digest
) values (
  'ev-ng-onramp-001', 'tenant-a', 'ng-onramp', 'bank-primary', 'NGN',
  100000000, 1000000, 100000,
  now(), now() + interval '10 minutes',
  'approved-treasury-service',
  '<64 lowercase hexadecimal SHA-256 digest>'
);
```

Never use synthetic evidence in a production GO bundle. Staging rehearsal data must be labeled and bound to its reconciliation run ID.

## 4. Enable the adapter

The payment-engine deployment must receive PostgreSQL and Redis references through secret-backed environment variables:

```yaml
env:
  - name: PAYMENT_DATABASE_URL
    valueFrom:
      secretKeyRef:
        name: umoja-payment-engine-database
        key: application-url
  - name: LIQUIDITY_REDIS_URL
    valueFrom:
      secretKeyRef:
        name: umoja-payment-engine-redis
        key: url
  - name: LIQUIDITY_REQUIRE_REDIS
    value: "true"
  - name: LIQUIDITY_LOCK_TTL
    value: "5s"
  - name: LIQUIDITY_LOCK_ATTEMPTS
    value: "100"
  - name: LIQUIDITY_LOCK_RETRY_DELAY
    value: "5ms"
  - name: LIQUIDITY_CACHE_TTL
    value: "60s"
  - name: OTEL_SERVICE_NAME
    value: umoja-payment-engine
  - name: OTEL_EXPORTER_OTLP_ENDPOINT
    value: http://otel-collector.observability:4317
```

The composition must construct:

```go
&settlement.PostgresRedisLiquidityVerifier{
    DB: db,
    Redis: redisClient,
    RequireRedis: true,
    LockTTL: 5 * time.Second,
    LockAttempts: 100,
    LockRetryDelay: 5 * time.Millisecond,
    CacheTTL: time.Minute,
}
```

Do not enable a fallback to `StaticLiquidityVerifier` in staging or production. If PostgreSQL or Redis is unavailable, settlement admission must fail closed.

## 5. Run pre-promotion checks

```bash
cd services/payment-engine
export PATH="/home/ubuntu/UmojaFlowOS-repo/.toolchain/go/bin:$PATH"

gofmt -w internal/settlement
go test ./internal/settlement -count=1
go test ./... -count=1
```

Run real-container integration tests on a host with a functioning Docker or Podman runtime:

```bash
RUN_REAL_CONTAINERS=1 \
  go test ./internal/settlement \
  -tags=integration \
  -run TestPostgresRedisLiquidityVerifier_RealContainers \
  -count=1 -v
```

The test provisions PostgreSQL 16 and Redis 7, applies the integration schema, verifies 32 concurrent admissions with fresh evidence, updates treasury evidence to an insufficient state, and verifies that all 32 subsequent admissions are denied.

## 6. Verify OTel telemetry

Import:

```text
infra/monitoring/grafana-settlement-liquidity-dashboard.json
```

The dashboard monitors:

```text
umoja_settlement_liquidity_denials_total
umoja_settlement_liquidity_checks_total
umoja_settlement_liquidity_check_duration_ms_bucket
umoja_settlement_route_decisions_total
```

Verify Prometheus:

```bash
curl -fsS http://prometheus.monitoring:9090/api/v1/query \
  --data-urlencode 'query=sum(rate(umoja_settlement_liquidity_denials_total[5m]))'

curl -fsS http://prometheus.monitoring:9090/api/v1/query \
  --data-urlencode 'query=histogram_quantile(0.95, sum by (le) (rate(umoja_settlement_liquidity_check_duration_ms_bucket[5m])))'
```

Tenant labels must be present and must not contain payment payloads, account numbers, secrets, or raw counterparty identifiers.

## 7. Failure and rollback checks

Inject each failure in staging and confirm no ledger post occurs:

```text
PostgreSQL unavailable
Redis unavailable
Redis lock exhaustion
missing route
missing evidence
expired evidence
invalid evidence digest
available - reserved < amount + buffer
contradictory reserved > available
```

Expected result:

```text
settlement state: HELD or UNKNOWN according to the existing coordinator state machine
ledger posts: 0
liquidity denial metric: incremented
trace span: settlement.liquidity.verify with error status
```

To disable the feature, do not silently fall back to static evidence. First fence settlement, drain payment-engine replicas, restore a valid database/Redis path, and then roll back the deployment if required.

## 8. Acceptance criteria

Staging enablement is accepted only when:

| Criterion | Required result |
|---|---|
| Migration | 0061 applied by schema owner with no errors. |
| RLS | Tenant A cannot read or use Tenant B’s route/evidence. |
| Redis | TLS/authenticated PING and lock acquisition succeed. |
| PostgreSQL | Fresh evidence is read in a transaction with row locking. |
| Concurrency | Concurrent fresh/insufficient updates produce no unauthorized admission. |
| OTel | Denial and latency metrics are visible in Prometheus/Grafana. |
| Fail closed | Every dependency or evidence ambiguity blocks settlement. |
| Rollback | Adapter disablement never enables static or unverified liquidity. |
| Evidence | Logs, traces, metrics, migration output, and test results are bound to the staging run ID. |

Only after all criteria pass may the staging approval role issue the corridor/liquidity evidence approval. Production remains gated by the four-role release manifest and E-01–E-09 evidence process.
