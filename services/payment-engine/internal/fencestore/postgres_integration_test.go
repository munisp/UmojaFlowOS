package fencestore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/lib/pq"
	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/reconciliation"
)

func openFenceIntegrationDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := os.Getenv("UMOJA_FENCE_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("UMOJA_FENCE_TEST_DATABASE_URL is not set")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		t.Fatalf("postgres unavailable: %v", err)
	}
	return db
}

func integrationFenceCommand(environment, id, reason string) reconciliation.FenceCommand {
	now := time.Now().UTC().Truncate(time.Microsecond)
	return reconciliation.FenceCommand{CommandID: id, Action: reconciliation.FenceActionFence, Reason: reason, Environment: environment, SourceAlerts: []string{"UmojaOPARetryExhaustion"}, IssuedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Minute), Nonce: "0123456789abcdef-" + id, Signer: "integration-test"}
}

func TestPostgresFenceStoreReplayIdempotencyAndConflict(t *testing.T) {
	db := openFenceIntegrationDB(t)
	defer db.Close()
	environment := "test-" + strings.ToLower(strings.ReplaceAll(t.Name(), "/", "-"))
	_, err := db.Exec(`DELETE FROM settlement_fence_commands WHERE environment=$1`, environment)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Exec(`DELETE FROM settlement_fence_commands WHERE environment=$1`, environment)
	store := &PostgresStore{DB: db}
	command := integrationFenceCommand(environment, "command-replay-001", "OPA retry exhaustion")
	if err := store.RecordFenceCommandContext(context.Background(), command, ""); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordFenceCommandContext(context.Background(), command, ""); err != nil {
		t.Fatalf("same replay should be idempotent: %v", err)
	}
	conflict := command
	conflict.Reason = "tampered reason"
	if err := store.RecordFenceCommandContext(context.Background(), conflict, ""); !errors.Is(err, ErrReplayConflict) {
		t.Fatalf("conflict error=%v, want ErrReplayConflict", err)
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM settlement_fence_commands WHERE command_id=$1`, command.CommandID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("stored rows=%d, want 1", count)
	}
}

func TestPostgresFenceStoreConcurrentReplicasUseUniqueSequenceVersions(t *testing.T) {
	admin := openFenceIntegrationDB(t)
	defer admin.Close()
	environment := "test-" + strings.ToLower(strings.ReplaceAll(t.Name(), "/", "-"))
	_, err := admin.Exec(`DELETE FROM settlement_fence_commands WHERE environment=$1`, environment)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(`DELETE FROM settlement_fence_commands WHERE environment=$1`, environment)

	const replicas = 8
	const commandsPerReplica = 25
	stores := make([]*PostgresStore, replicas)
	for i := range stores {
		db, err := sql.Open("postgres", os.Getenv("UMOJA_FENCE_TEST_DATABASE_URL"))
		if err != nil {
			t.Fatal(err)
		}
		stores[i] = &PostgresStore{DB: db}
		defer db.Close()
	}
	var wg sync.WaitGroup
	var failures atomic.Int64
	for replica, store := range stores {
		wg.Add(1)
		go func(replica int, store *PostgresStore) {
			defer wg.Done()
			for i := 0; i < commandsPerReplica; i++ {
				id := fmt.Sprintf("command-%02d-%03d", replica, i)
				if err := store.RecordFenceCommandContext(context.Background(), integrationFenceCommand(environment, id, "stress"), ""); err != nil {
					failures.Add(1)
				}
			}
		}(replica, store)
	}
	wg.Wait()
	if got := failures.Load(); got != 0 {
		t.Fatalf("concurrent insert failures=%d", got)
	}
	var rows, versions, duplicates int
	if err := admin.QueryRow(`SELECT count(*), count(DISTINCT fence_version), count(*)-count(DISTINCT fence_version) FROM settlement_fence_commands WHERE environment=$1`, environment).Scan(&rows, &versions, &duplicates); err != nil {
		t.Fatal(err)
	}
	want := replicas * commandsPerReplica
	if rows != want || versions != want || duplicates != 0 {
		t.Fatalf("rows=%d versions=%d duplicates=%d want=%d", rows, versions, duplicates, want)
	}
}
