//go:build integration

package reconciliation

import (
	"context"
	"database/sql"
	"os"
	"testing"
	"time"

	_ "github.com/lib/pq"
)

func TestNativeStablecoinIntentRLSIsolation(t *testing.T) {
	dsn := os.Getenv("UMOJA_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("UMOJA_TEST_DATABASE_URL is not set")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		t.Fatal(err)
	}

	// The test role must not be a superuser and must have the migration applied.
	var isSuper bool
	if err := db.QueryRowContext(ctx, `SELECT rolsuper FROM pg_roles WHERE rolname=current_user`).Scan(&isSuper); err != nil {
		t.Fatal(err)
	}
	if isSuper {
		t.Fatal("RLS test must run as a non-superuser")
	}

	id := "00000000-0000-0000-0000-000000000058"
	cleanup := func() {
		_, _ = db.ExecContext(ctx, `DELETE FROM stablecoin_idempotency_key WHERE tenant_id IN ('rls-tenant-a','rls-tenant-b'); DELETE FROM stablecoin_intent WHERE tenant_id IN ('rls-tenant-a','rls-tenant-b')`)
	}
	defer cleanup()
	cleanup()

	insert := func(tenant string) error {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if _, err = tx.ExecContext(ctx, `SELECT set_config('app.tenant_id',$1,true)`, tenant); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO stablecoin_intent (id,tenant_id,idempotency_key,payload,payload_sha256,asset,fiat,amount_minor,direction,release_sha,reconciliation_run_id) VALUES ($1,$2,$3,'{}'::jsonb,repeat('a',64),'USDC','NGN',100,'onramp',repeat('b',40),'rls-test-run-20260902')`, id, tenant, "key-"+tenant)
		if err != nil {
			return err
		}
		return tx.Commit()
	}
	if err := insert("rls-tenant-a"); err != nil {
		t.Fatal(err)
	}
	if err := insert("rls-tenant-b"); err != nil {
		t.Fatal(err)
	}

	queryCount := func(tenant string) (int, error) {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return 0, err
		}
		defer tx.Rollback()
		if _, err = tx.ExecContext(ctx, `SELECT set_config('app.tenant_id',$1,true)`, tenant); err != nil {
			return 0, err
		}
		var count int
		err = tx.QueryRowContext(ctx, `SELECT count(*) FROM stablecoin_intent`).Scan(&count)
		return count, err
	}
	if count, err := queryCount("rls-tenant-a"); err != nil || count != 1 {
		t.Fatalf("tenant A count=%d err=%v", count, err)
	}
	if count, err := queryCount("rls-tenant-b"); err != nil || count != 1 {
		t.Fatalf("tenant B count=%d err=%v", count, err)
	}

	var withoutContext int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM stablecoin_intent`).Scan(&withoutContext); err != nil {
		t.Fatal(err)
	}
	if withoutContext != 0 {
		t.Fatalf("missing tenant context exposed %d rows", withoutContext)
	}
}
