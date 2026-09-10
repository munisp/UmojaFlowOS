//go:build integration

package settlement

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/redis/go-redis/v9"
	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/modules/postgres"
	rediscontainer "github.com/testcontainers/testcontainers-go/modules/redis"
	"github.com/testcontainers/testcontainers-go/wait"
)

const integrationSchema = `
CREATE TABLE corridor_routes (
    route_id text PRIMARY KEY,
    tenant_id text NOT NULL,
    source_currency char(3) NOT NULL,
    enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE liquidity_treasury_evidence (
    evidence_id text PRIMARY KEY,
    tenant_id text NOT NULL,
    route_id text NOT NULL REFERENCES corridor_routes(route_id),
    provider text NOT NULL,
    currency char(3) NOT NULL,
    available_minor bigint NOT NULL,
    reserved_minor bigint NOT NULL,
    required_buffer_minor bigint NOT NULL,
    observed_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    source text NOT NULL,
    evidence_digest text NOT NULL
);
`

func TestPostgresRedisLiquidityVerifier_RealContainers(t *testing.T) {
	if os.Getenv("RUN_REAL_CONTAINERS") != "1" {
		t.Skip("set RUN_REAL_CONTAINERS=1 to run PostgreSQL/Redis Testcontainers integration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	pg, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("umoja_test"),
		postgres.WithUsername("umoja"),
		postgres.WithPassword("umoja_test_password"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(2*time.Minute),
		),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Terminate(context.Background())

	redisC, err := rediscontainer.Run(ctx, "redis:7-alpine")
	if err != nil {
		t.Fatal(err)
	}
	defer redisC.Terminate(context.Background())

	pgDSN, err := pg.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("pgx", pgDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, integrationSchema); err != nil {
		t.Fatal(err)
	}

	redisAddr, err := redisC.Endpoint(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	redisClient := redis.NewClient(&redis.Options{Addr: redisAddr})
	defer redisClient.Close()
	if err := redisClient.Ping(ctx).Err(); err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC()
	const digest = "0000000000000000000000000000000000000000000000000000000000000000"
	_, err = db.ExecContext(ctx, `INSERT INTO corridor_routes(route_id, tenant_id, source_currency) VALUES ($1,$2,$3)`, "ng-onramp", "tenant-a", "NGN")
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(ctx, `INSERT INTO liquidity_treasury_evidence(evidence_id,tenant_id,route_id,provider,currency,available_minor,reserved_minor,required_buffer_minor,observed_at,expires_at,source,evidence_digest) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, "ev-1", "tenant-a", "ng-onramp", "bank-primary", "NGN", 100000, 0, 1000, now.Add(-time.Minute), now.Add(time.Hour), "integration", digest)
	if err != nil {
		t.Fatal(err)
	}

	v := &PostgresRedisLiquidityVerifier{
		DB: db, Redis: redisClient, RequireRedis: true,
		LockTTL: 5 * time.Second, LockAttempts: 100, LockRetryDelay: 5 * time.Millisecond,
		Now: func() time.Time { return now },
	}
	in := validIntent()
	in.TenantID = "tenant-a"
	in.AmountMinor = 1000
	route := RouteDecision{Route: CorridorRoute{ID: "ng-onramp", TenantID: "tenant-a", SourceCurrency: "NGN"}, Provider: "bank-primary", Rail: "mojaloop"}

	var allowed atomic.Int64
	var denied atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			decision, verifyErr := v.Verify(ctx, in, route)
			if verifyErr == nil && decision.Allowed {
				allowed.Add(1)
			} else {
				denied.Add(1)
			}
		}()
	}
	wg.Wait()
	if allowed.Load() != 32 || denied.Load() != 0 {
		t.Fatalf("fresh evidence allowed=%d denied=%d", allowed.Load(), denied.Load())
	}

	if _, err := db.ExecContext(ctx, `UPDATE liquidity_treasury_evidence SET available_minor=1000, reserved_minor=900 WHERE evidence_id='ev-1'`); err != nil {
		t.Fatal(err)
	}
	allowed.Store(0)
	denied.Store(0)
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			decision, verifyErr := v.Verify(ctx, in, route)
			if verifyErr == nil && decision.Allowed {
				allowed.Add(1)
			} else {
				denied.Add(1)
			}
		}()
	}
	wg.Wait()
	if allowed.Load() != 0 || denied.Load() != 32 {
		t.Fatalf("insufficient evidence allowed=%d denied=%d", allowed.Load(), denied.Load())
	}
}

func TestMigration0061PostgresRLSIsolatesConcurrentTenants(t *testing.T) {
	if os.Getenv("RUN_REAL_CONTAINERS") != "1" {
		t.Skip("set RUN_REAL_CONTAINERS=1 to run live PostgreSQL RLS acceptance")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	pg, err := postgres.Run(ctx, "postgres:16-alpine",
		postgres.WithDatabase("umoja_test"),
		postgres.WithUsername("postgres"),
		postgres.WithPassword("postgres_test_password"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(2*time.Minute),
		),
	)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Terminate(context.Background())

	dsn, err := pg.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	admin, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	if err := admin.PingContext(ctx); err != nil {
		t.Fatal(err)
	}

	migrationPath := filepath.Join("..", "..", "..", "..", "database", "postgresql", "0061_corridor_liquidity_policy.sql")
	migration, err := os.ReadFile(migrationPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.ExecContext(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}

	_, err = admin.ExecContext(ctx, `
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'umoja_rls_app') THEN
        CREATE ROLE umoja_rls_app LOGIN PASSWORD 'umoja_rls_password' NOSUPERUSER NOBYPASSRLS;
    END IF;
END $$;
GRANT USAGE ON SCHEMA public TO umoja_rls_app;
GRANT SELECT, INSERT, UPDATE ON corridor_routes, liquidity_treasury_evidence TO umoja_rls_app;
`)
	if err != nil {
		t.Fatal(err)
	}

	_, err = admin.ExecContext(ctx, `
INSERT INTO corridor_routes(route_id, tenant_id, origin_country, destination_country, source_currency, destination_currency, direction, asset, rails, provider_priority, min_amount_minor, quote_ttl_seconds, liquidity_buffer_bps)
VALUES ('rls-route-a', 'tenant-a', 'NG', 'GB', 'NGN', 'GBP', 'onramp', 'fiat', '["mojaloop"]', '["bank-primary"]', 1, 300, 50),
       ('rls-route-b', 'tenant-b', 'NG', 'US', 'NGN', 'USD', 'onramp', 'fiat', '["mojaloop"]', '["bank-primary"]', 1, 300, 50)
ON CONFLICT (route_id) DO NOTHING;
`)
	if err != nil {
		t.Fatal(err)
	}

	appDSN := dsn + " user=umoja_rls_app password=umoja_rls_password"
	tenantA, err := sql.Open("pgx", appDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer tenantA.Close()
	tenantB, err := sql.Open("pgx", appDSN)
	if err != nil {
		t.Fatal(err)
	}
	defer tenantB.Close()

	const workers = 24
	var wg sync.WaitGroup
	var wrongReads atomic.Int64
	var deniedCrossWrites atomic.Int64
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			db := tenantA
			tenant := "tenant-a"
			if i%2 == 1 {
				db = tenantB
				tenant = "tenant-b"
			}
			tx, txErr := db.BeginTx(ctx, nil)
			if txErr != nil {
				t.Error(txErr)
				return
			}
			defer tx.Rollback()
			if _, txErr = tx.ExecContext(ctx, "SELECT set_config('umoja.tenant_id', $1, true)", tenant); txErr != nil {
				t.Error(txErr)
				return
			}
			rows, txErr := tx.QueryContext(ctx, `SELECT tenant_id FROM corridor_routes ORDER BY route_id`)
			if txErr != nil {
				t.Error(txErr)
				return
			}
			for rows.Next() {
				var visibleTenant string
				if txErr = rows.Scan(&visibleTenant); txErr != nil {
					t.Error(txErr)
					break
				}
				if visibleTenant != tenant {
					wrongReads.Add(1)
				}
			}
			rows.Close()
			if txErr = rows.Err(); txErr != nil {
				t.Error(txErr)
			}
			if _, txErr = tx.ExecContext(ctx, `INSERT INTO corridor_routes(route_id, tenant_id, origin_country, destination_country, source_currency, destination_currency, direction, asset, rails, provider_priority, min_amount_minor, quote_ttl_seconds, liquidity_buffer_bps) VALUES ($1, 'tenant-a', 'NG', 'CA', 'NGN', 'CAD', 'onramp', 'fiat', '["mojaloop"]', '["bank-primary"]', 1, 300, 50)`, tenant+"-cross-write"); txErr == nil {
				wrongReads.Add(1)
			} else {
				deniedCrossWrites.Add(1)
			}
		}(i)
	}
	wg.Wait()

	if wrongReads.Load() != 0 {
		t.Fatalf("RLS leaked cross-tenant rows or permitted cross-tenant writes: violations=%d", wrongReads.Load())
	}
	if deniedCrossWrites.Load() != workers {
		t.Fatalf("expected all cross-tenant writes to be denied: denied=%d workers=%d", deniedCrossWrites.Load(), workers)
	}
}
