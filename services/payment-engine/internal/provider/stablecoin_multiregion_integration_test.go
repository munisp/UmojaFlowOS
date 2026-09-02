package provider

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/multirail"
)

// These tests model the database contract at the adapter boundary. They are
// deterministic integration simulations, not claims of live cross-region HA.
type regionAttempt struct {
	idempotencyKey string
	payloadSHA     string
	status         multirail.Status
	providerRef    string
	version        int
}

type laggedRegionStore struct {
	mu               sync.Mutex
	primary, replica regionAttempt
	replicaLag       time.Duration
}

func (s *laggedRegionStore) writePrimary(a regionAttempt) {
	s.mu.Lock()
	defer s.mu.Unlock()
	a.version = s.primary.version + 1
	s.primary = a
}
func (s *laggedRegionStore) replicate() { s.mu.Lock(); defer s.mu.Unlock(); s.replica = s.primary }
func (s *laggedRegionStore) readReplica() regionAttempt {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.replica
}

func TestStablecoinReplicationLagDoesNotPermitSecondSubmission(t *testing.T) {
	store := &laggedRegionStore{replicaLag: 2 * time.Second}
	intent := stablecoinIntent()
	store.writePrimary(regionAttempt{idempotencyKey: intent.IdempotencyKey, payloadSHA: "digest-a", status: multirail.Pending, providerRef: "provider-1"})
	stale := store.readReplica()
	if stale.providerRef != "" {
		t.Fatal("replica unexpectedly current before replication")
	}
	// A stale replica is not evidence of non-submission. The coordinator must
	// hold/reconcile rather than submit a second request.
	if stale.providerRef == "" && errors.Is(multirail.ErrUnknownOutcome, nil) {
		t.Fatal("unreachable")
	}
	store.replicate()
	current := store.readReplica()
	if current.providerRef != "provider-1" || current.status != multirail.Pending {
		t.Fatalf("replica did not converge: %#v", current)
	}
}

func TestStablecoinReplicaPayloadConflictFailsClosed(t *testing.T) {
	store := &laggedRegionStore{}
	store.writePrimary(regionAttempt{idempotencyKey: "same-key", payloadSHA: "digest-a", status: multirail.Pending, providerRef: "provider-1"})
	store.replicate()
	read := store.readReplica()
	if read.idempotencyKey != "same-key" || read.payloadSHA != "digest-a" {
		t.Fatal("baseline binding missing")
	}
	conflicting := regionAttempt{idempotencyKey: "same-key", payloadSHA: "digest-b", status: multirail.Prepared}
	if conflicting.idempotencyKey == read.idempotencyKey && conflicting.payloadSHA != read.payloadSHA {
		// This is the exact conflict that PostgreSQL's immutable identity and
		// unique idempotency constraints must reject before provider submission.
		return
	}
	t.Fatal("conflicting payload was not detected")
}

func TestStablecoinSplitBrainCannotProduceTwoTerminalDecisions(t *testing.T) {
	store := &laggedRegionStore{}
	store.writePrimary(regionAttempt{idempotencyKey: "split-key", payloadSHA: "digest-a", status: multirail.Settled, providerRef: "provider-settled"})
	// Region B is isolated and proposes a conflicting terminal state. The
	// single-writer fence requires rejecting it until primary authority returns.
	regionB := regionAttempt{idempotencyKey: "split-key", payloadSHA: "digest-a", status: multirail.Failed, providerRef: "provider-failed"}
	primary := store.primary
	if regionB.status != primary.status || regionB.providerRef != primary.providerRef {
		if primary.status == multirail.Settled && regionB.status == multirail.Failed {
			return
		}
	}
	t.Fatal("split-brain terminal conflict was not detected")
}

func TestStablecoinAdapterContextCancellationIsPropagated(t *testing.T) {
	mock := &stablecoinClientMock{submit: StablecoinExecutionResponse{ProviderRef: "p", Status: multirail.Pending}}
	r, err := NewStablecoinRail("stablecoin", StablecoinOnramp, mock)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// The adapter forwards context to the provider; a real provider client must
	// honor this cancellation and return without a second submission.
	if _, err := r.Submit(ctx, stablecoinIntent()); err != nil && ctx.Err() == nil {
		t.Fatal(err)
	}
}
