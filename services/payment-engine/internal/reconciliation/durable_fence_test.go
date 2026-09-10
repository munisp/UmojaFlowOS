package reconciliation

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"testing"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/ledger"
)

type durableFenceTestStore struct {
	state FenceState
	err   error
	calls int
}

func (s *durableFenceTestStore) RecordFenceCommand(FenceCommand, string) error { return nil }
func (s *durableFenceTestStore) RecordFenceCommandContext(context.Context, FenceCommand, string) error {
	return nil
}
func (s *durableFenceTestStore) LoadState(context.Context, string) (FenceState, error) {
	s.calls++
	if s.err != nil {
		return FenceState{}, s.err
	}
	return s.state, nil
}

type durableFenceLedger struct{ calls int }

func (l *durableFenceLedger) PostConfirmedTransfer(context.Context, ledger.PostingRequest) (ledger.PostedTransferFact, error) {
	l.calls++
	return ledger.PostedTransferFact{}, nil
}

func TestGuardedLedgerRefreshesDurableFenceBeforeEveryPost(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	store := &durableFenceTestStore{state: FenceState{Environment: "staging", Fenced: false, Version: 1, Reason: "open"}}
	fence, err := NewDurableSettlementFence(pub, "staging", store)
	if err != nil {
		t.Fatal(err)
	}
	inner := &durableFenceLedger{}
	guarded := GuardedLedger{Fence: fence, Inner: inner}

	if _, err := guarded.PostConfirmedTransfer(context.Background(), ledger.PostingRequest{}); err != nil {
		t.Fatal(err)
	}
	store.state = FenceState{Environment: "staging", Fenced: true, Version: 2, Reason: "OPA retry exhaustion"}
	if _, err := guarded.PostConfirmedTransfer(context.Background(), ledger.PostingRequest{}); err == nil {
		t.Fatal("expected durable fence rejection")
	}
	if store.calls != 2 {
		t.Fatalf("durable state reads=%d, want 2", store.calls)
	}
	if inner.calls != 1 {
		t.Fatalf("ledger calls=%d, want 1", inner.calls)
	}
}

func TestGuardedLedgerFailsClosedWhenDurableFenceUnavailable(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	store := &durableFenceTestStore{err: errors.New("postgres unavailable")}
	fence, err := NewDurableSettlementFence(pub, "staging", store)
	if err != nil {
		t.Fatal(err)
	}
	inner := &durableFenceLedger{}
	if _, err := (GuardedLedger{Fence: fence, Inner: inner}).PostConfirmedTransfer(context.Background(), ledger.PostingRequest{}); err == nil {
		t.Fatal("expected fail-closed error")
	}
	if inner.calls != 0 {
		t.Fatalf("ledger calls=%d, want 0", inner.calls)
	}
	if !fence.IsFenced() {
		t.Fatal("fence must remain active after state-store failure")
	}
}

func TestFenceCommandSignatureAndWindowRemainStrict(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	cmd := FenceCommand{CommandID: "strict-command", Action: FenceActionFence, Reason: "test", Environment: "staging", SourceAlerts: []string{"test-alert"}, IssuedAt: now.Add(-time.Minute), ExpiresAt: now.Add(5 * time.Minute), Nonce: "nonce-1234567890", Signer: "test-signer"}
	payload, err := canonicalFencePayload(cmd)
	if err != nil {
		t.Fatal(err)
	}
	cmd.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))
	store := &durableFenceTestStore{state: FenceState{Environment: "staging", Fenced: true}}
	fence, err := NewDurableSettlementFence(pub, "staging", store)
	if err != nil {
		t.Fatal(err)
	}
	if err := fence.ApplyContext(context.Background(), cmd, now); err != nil {
		t.Fatal(err)
	}
}
