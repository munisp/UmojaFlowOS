package reconciliation

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"testing"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/ledger"
)

type blockingFenceStore struct {
	err error
}

func (s *blockingFenceStore) RecordFenceCommand(FenceCommand, string) error { return nil }
func (s *blockingFenceStore) RecordFenceCommandContext(context.Context, FenceCommand, string) error {
	return nil
}
func (s *blockingFenceStore) LoadState(ctx context.Context, _ string) (FenceState, error) {
	if s.err != nil {
		return FenceState{}, s.err
	}
	<-ctx.Done()
	return FenceState{}, ctx.Err()
}

func newFailureTestFence(t *testing.T, store FenceStateCommandStore) *SettlementFence {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	fence, err := NewDurableSettlementFence(pub, "staging", store)
	if err != nil {
		t.Fatal(err)
	}
	return fence
}

func TestGuardedLedgerRejectsDurableFenceReadTimeout(t *testing.T) {
	fence := newFailureTestFence(t, &blockingFenceStore{})
	inner := &durableFenceLedger{}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()

	_, err := (GuardedLedger{Fence: fence, Inner: inner}).PostConfirmedTransfer(ctx, ledger.PostingRequest{})
	if err == nil {
		t.Fatal("expected durable fence timeout")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error=%v, want context deadline exceeded", err)
	}
	if inner.calls != 0 {
		t.Fatalf("ledger calls=%d, want 0", inner.calls)
	}
	if !fence.IsFenced() {
		t.Fatal("fence must remain active after timeout")
	}
}

func TestGuardedLedgerRejectsDurableFenceNetworkPartition(t *testing.T) {
	partitionErr := errors.New("dial tcp: network is unreachable")
	fence := newFailureTestFence(t, &blockingFenceStore{err: partitionErr})
	inner := &durableFenceLedger{}

	_, err := (GuardedLedger{Fence: fence, Inner: inner}).PostConfirmedTransfer(context.Background(), ledger.PostingRequest{})
	if err == nil {
		t.Fatal("expected durable fence network failure")
	}
	if !errors.Is(err, partitionErr) {
		t.Fatalf("error=%v, want wrapped network error", err)
	}
	if inner.calls != 0 {
		t.Fatalf("ledger calls=%d, want 0", inner.calls)
	}
	if !fence.IsFenced() {
		t.Fatal("fence must remain active after network partition")
	}
}
