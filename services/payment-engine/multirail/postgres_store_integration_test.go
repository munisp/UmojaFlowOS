//go:build integration

package multirail

import (
	"context"
	"database/sql"
	"os"
	"sync"
	"testing"
	"time"

	_ "github.com/lib/pq"
)

func TestCrossReplicaUnknownStoreClaimAndPayloadBinding(t *testing.T) {
	dsn := os.Getenv("UMOJA_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("UMOJA_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	instanceA, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer instanceA.Close()
	instanceB, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer instanceB.Close()
	if err := instanceA.PingContext(ctx); err != nil {
		t.Fatal(err)
	}
	if err := instanceB.PingContext(ctx); err != nil {
		t.Fatal(err)
	}

	key := "cross-replica-" + time.Now().UTC().Format("20060102150405.000000000")
	payload := []byte(`{"sequenceId":"cross-replica"}`)
	state := UnknownState{Intent: Intent{ID: key, IdempotencyKey: key, Payload: payload}, PrimaryRail: "yellow_card", ObservedStatus: Unknown, NextAttemptAt: time.Now().UTC()}
	storeA := &PostgresUnknownStateStore{DB: instanceA, LeaseDuration: time.Minute}
	storeB := &PostgresUnknownStateStore{DB: instanceB, LeaseDuration: time.Minute}
	defer func() {
		_, _ = instanceA.ExecContext(ctx, `DELETE FROM provider_reconciliation_decision WHERE idempotency_key=$1`, key)
		_, _ = instanceA.ExecContext(ctx, `DELETE FROM provider_unknown_reconciliation WHERE idempotency_key=$1`, key)
	}()
	if err := storeA.EnqueueUnknown(ctx, state); err != nil {
		t.Fatal(err)
	}
	if err := storeB.EnqueueUnknown(ctx, state); err != nil {
		t.Fatal(err)
	}
	changed := state
	changed.Intent.Payload = []byte(`{"sequenceId":"cross-replica","amount":999}`)
	if err := storeB.EnqueueUnknown(ctx, changed); err != ErrIdempotencyBinding {
		t.Fatalf("changed payload error=%v, want ErrIdempotencyBinding", err)
	}

	results := make(chan bool, 2)
	var wg sync.WaitGroup
	for _, store := range []*PostgresUnknownStateStore{storeA, storeB} {
		wg.Add(1)
		go func(s *PostgresUnknownStateStore) {
			defer wg.Done()
			_, claimed, claimErr := s.Claim(ctx, key, time.Now().UTC())
			if claimErr != nil {
				t.Errorf("claim error: %v", claimErr)
				return
			}
			results <- claimed
		}(store)
	}
	wg.Wait()
	close(results)
	claimedCount := 0
	for claimed := range results {
		if claimed {
			claimedCount++
		}
	}
	if claimedCount != 1 {
		t.Fatalf("claimed instances=%d, want exactly one", claimedCount)
	}
}
