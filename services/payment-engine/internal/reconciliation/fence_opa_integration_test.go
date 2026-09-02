package reconciliation

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/eventing"
	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/ledger"
	"github.com/twmb/franz-go/pkg/kgo"
)

type fenceAuditTest struct {
	mu    sync.Mutex
	count int
}

func (a *fenceAuditTest) RecordFenceCommand(FenceCommand, string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.count++
	return nil
}

type countingLedger struct {
	mu    sync.Mutex
	calls int
}

func (l *countingLedger) PostConfirmedTransfer(context.Context, ledger.PostingRequest) (ledger.PostedTransferFact, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls++
	return ledger.PostedTransferFact{}, nil
}

type retryExhaustionPolicy struct{ calls int }

func (p *retryExhaustionPolicy) Evaluate(context.Context, IntentPolicyInput) (IntentPolicyDecision, error) {
	p.calls++
	return IntentPolicyDecision{}, context.DeadlineExceeded
}

type integrationStore struct {
	unknown   int
	processed int
	intent    IntentRecord
}

func (s *integrationStore) ReserveEvent(context.Context, SettlementReconciledPayload, string, time.Time) (bool, error) {
	return true, nil
}
func (s *integrationStore) LoadIntent(context.Context, string, string) (IntentRecord, error) {
	return s.intent, nil
}
func (s *integrationStore) MarkUnknown(context.Context, SettlementReconciledPayload, string, time.Time) error {
	s.unknown++
	return nil
}
func (s *integrationStore) MarkSettled(context.Context, SettlementReconciledPayload, uint64, string, time.Time) error {
	return nil
}
func (s *integrationStore) MarkEventProcessed(context.Context, string, string, time.Time) error {
	s.processed++
	return nil
}

func signedFenceCommand(t *testing.T, action FenceAction, now time.Time, priv ed25519.PrivateKey) FenceCommand {
	t.Helper()
	cmd := FenceCommand{CommandID: "cmd-" + string(action), Action: action, Reason: "OPA retry exhaustion", Environment: "staging", SourceAlerts: []string{"UmojaOPARetryExhaustion"}, IssuedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour), Nonce: "nonce-1", Signer: "alertmanager-fence-bridge"}
	payload, err := canonicalFencePayload(cmd)
	if err != nil {
		t.Fatal(err)
	}
	cmd.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(priv, payload))
	return cmd
}

func TestSettlementFenceRejectsLedgerPostsWhileFenced(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	audit := &fenceAuditTest{}
	fence, err := NewSettlementFence(pub, audit)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if err := fence.Apply(signedFenceCommand(t, FenceActionOpen, now, priv), now); err != nil {
		t.Fatal(err)
	}
	ledgerClient := &countingLedger{}
	guarded := GuardedLedger{Fence: fence, Inner: ledgerClient}
	if _, err := guarded.PostConfirmedTransfer(context.Background(), ledger.PostingRequest{}); err != nil {
		t.Fatal(err)
	}
	if err := fence.Apply(signedFenceCommand(t, FenceActionFence, now, priv), now); err != nil {
		t.Fatal(err)
	}
	if _, err := guarded.PostConfirmedTransfer(context.Background(), ledger.PostingRequest{}); err == nil {
		t.Fatal("expected fenced ledger post to be rejected")
	}
	if ledgerClient.calls != 1 {
		t.Fatalf("ledger calls=%d, want 1", ledgerClient.calls)
	}
	if audit.count != 2 {
		t.Fatalf("audit records=%d, want 2", audit.count)
	}
}

func TestOPAExhaustionRecordsUnknownAndDoesNotTransfer(t *testing.T) {
	payload := SettlementReconciledPayload{TenantID: "tenant-a", IntentID: "intent-1", IdempotencyKey: "idem-1", ReleaseSHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ReconciliationRunID: "recovery-run-20260902", Status: "CONFIRMED", Asset: "USDC", AmountMinor: 10, DebitAccountID: 1, CreditAccountID: 2, ProviderFinal: true, BusinessEffect: true}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	envelope := eventing.Envelope{EventID: "event-1", EventType: SettlementReconciledV1, SchemaVersion: "v1", CorrelationID: payload.IntentID, Payload: encoded}
	value, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	store := &integrationStore{intent: IntentRecord{TenantID: payload.TenantID, IntentID: payload.IntentID, IdempotencyKey: payload.IdempotencyKey, ReleaseSHA: payload.ReleaseSHA, ReconciliationRunID: payload.ReconciliationRunID}}
	policy := &retryExhaustionPolicy{}
	ledgerClient := &countingLedger{}
	consumer := &Consumer{Topic: "reconciliation", Store: store, Policy: policy, Ledger: GuardedLedger{Inner: ledgerClient}, Now: func() time.Time { return time.Now().UTC() }}
	err = consumer.HandleRecord(context.Background(), &kgo.Record{Topic: "reconciliation", Value: value})
	if err == nil {
		t.Fatal("expected OPA exhaustion error for redelivery")
	}
	if !errors.Is(err, context.DeadlineExceeded) && policy.calls != opaRetryAttempts {
		t.Fatalf("calls=%d err=%v", policy.calls, err)
	}
	if policy.calls != opaRetryAttempts {
		t.Fatalf("OPA calls=%d, want %d", policy.calls, opaRetryAttempts)
	}
	if store.unknown != 1 {
		t.Fatalf("UNKNOWN writes=%d, want 1", store.unknown)
	}
	if ledgerClient.calls != 0 {
		t.Fatalf("ledger calls=%d, want 0", ledgerClient.calls)
	}
	if store.processed != 0 {
		t.Fatalf("processed=%d, want 0 because error is returned for redelivery", store.processed)
	}
}

func TestFenceCommandRejectsInvalidSignature(t *testing.T) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	fence, err := NewSettlementFence(pub, nil)
	if err != nil {
		t.Fatal(err)
	}
	cmd := FenceCommand{CommandID: "bad", Action: FenceActionFence, Reason: "bad", Environment: "staging", SourceAlerts: []string{"test"}, IssuedAt: time.Now().Add(-time.Minute), ExpiresAt: time.Now().Add(time.Minute), Nonce: "n", Signer: "x", Signature: base64.StdEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))}
	if err := fence.Apply(cmd, time.Now()); err == nil {
		t.Fatal("expected invalid signature rejection")
	}
}
