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

func TestPostgresUnknownStoreDuplicateTerminalDecisionIsImmutable(t *testing.T) {
	dsn := os.Getenv("UMOJA_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("UMOJA_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	db, err := sql.Open("postgres", dsn)
	if err != nil { t.Fatal(err) }
	defer db.Close()
	if err := db.PingContext(ctx); err != nil { t.Fatal(err) }
	key := "duplicate-decision-" + time.Now().UTC().Format("20060102150405.000000000")
	state := UnknownState{Intent: Intent{ID: key, IdempotencyKey: key, Payload: []byte(`{"intent":"duplicate-decision"}`)}, PrimaryRail: "yellow_card", ObservedStatus: Unknown, NextAttemptAt: time.Now().UTC()}
	store := &PostgresUnknownStateStore{DB: db, LeaseDuration: time.Minute}
	defer func() { _, _ = db.ExecContext(ctx, `DELETE FROM provider_reconciliation_decision WHERE idempotency_key=$1`, key); _, _ = db.ExecContext(ctx, `DELETE FROM provider_unknown_reconciliation WHERE idempotency_key=$1`, key) }()
	if err := store.EnqueueUnknown(ctx, state); err != nil { t.Fatal(err) }
	claimed, ok, err := store.Claim(ctx, key, time.Now().UTC())
	if err != nil || !ok { t.Fatalf("claim ok=%v err=%v", ok, err) }
	result := ReconciliationResult{IntentID: claimed.Intent.ID, IdempotencyKey: key, PrimaryRail: claimed.PrimaryRail, Decision: DecisionAwaitingEvidence, ObservedStatus: Unknown, Attempt: claimed.Attempts, DecidedAt: time.Now().UTC(), Reason: "provider evidence required", EvidenceDigest: "evidence-immutable-1", LeaseToken: claimed.LeaseToken}
	if err := store.RecordDecision(ctx, result); err != nil { t.Fatal(err) }
	if err := store.RecordDecision(ctx, result); err != nil { t.Fatalf("same immutable decision should be idempotent: %v", err) }
	conflict := result
	conflict.EvidenceDigest = "evidence-immutable-2"
	if err := store.RecordDecision(ctx, conflict); err != ErrDecisionConflict { t.Fatalf("conflicting terminal decision error=%v, want ErrDecisionConflict", err) }
}

func TestPostgresUnknownStoreRejectsStaleLeaseMutation(t *testing.T) {
	dsn := os.Getenv("UMOJA_TEST_DATABASE_URL")
	if dsn == "" { t.Skip("UMOJA_TEST_DATABASE_URL is not set") }
	ctx := context.Background()
	db, err := sql.Open("postgres", dsn)
	if err != nil { t.Fatal(err) }
	defer db.Close()
	if err := db.PingContext(ctx); err != nil { t.Fatal(err) }
	key := "stale-lease-" + time.Now().UTC().Format("20060102150405.000000000")
	state := UnknownState{Intent: Intent{ID: key, IdempotencyKey: key, Payload: []byte(`{"intent":"stale-lease"}`)}, PrimaryRail: "yellow_card", ObservedStatus: Unknown, NextAttemptAt: time.Now().UTC()}
	store := &PostgresUnknownStateStore{DB: db, LeaseDuration: time.Minute}
	defer func() { _, _ = db.ExecContext(ctx, `DELETE FROM provider_reconciliation_decision WHERE idempotency_key=$1`, key); _, _ = db.ExecContext(ctx, `DELETE FROM provider_unknown_reconciliation WHERE idempotency_key=$1`, key) }()
	if err := store.EnqueueUnknown(ctx, state); err != nil { t.Fatal(err) }
	claimed, ok, err := store.Claim(ctx, key, time.Now().UTC())
	if err != nil || !ok { t.Fatalf("claim ok=%v err=%v", ok, err) }
	stale := claimed
	stale.LeaseToken = "00000000-0000-4000-8000-000000000000"
	if err := store.Reschedule(ctx, stale, time.Now().UTC().Add(time.Minute), "stale worker"); err != ErrLeaseLost { t.Fatalf("stale reschedule error=%v, want ErrLeaseLost", err) }
	decision := ReconciliationResult{IntentID: claimed.Intent.ID, IdempotencyKey: key, PrimaryRail: claimed.PrimaryRail, Decision: DecisionAwaitingEvidence, ObservedStatus: Unknown, Attempt: claimed.Attempts, DecidedAt: time.Now().UTC(), Reason: "stale worker", EvidenceDigest: "stale-evidence", LeaseToken: stale.LeaseToken}
	if err := store.RecordDecision(ctx, decision); err != ErrLeaseLost { t.Fatalf("stale decision error=%v, want ErrLeaseLost", err) }
	if _, claimedAgain, err := store.Claim(ctx, key, time.Now().UTC().Add(2*time.Minute)); err != nil || !claimedAgain { t.Fatalf("active lease should remain claimable after stale mutation rejection: claimed=%v err=%v", claimedAgain, err) }
}
