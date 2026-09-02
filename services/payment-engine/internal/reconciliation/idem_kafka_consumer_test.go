package reconciliation

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/eventing"
	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/ledger"
	"github.com/twmb/franz-go/pkg/kgo"
)

type fakeStore struct {
	reserved                    bool
	intent                      IntentRecord
	unknown, settled, processed int
	settledFailures             int
}

func (s *fakeStore) ReserveEvent(context.Context, SettlementReconciledPayload, string, time.Time) (bool, error) {
	if s.reserved {
		return false, nil
	}
	s.reserved = true
	return true, nil
}
func (s *fakeStore) LoadIntent(context.Context, string, string) (IntentRecord, error) {
	return s.intent, nil
}
func (s *fakeStore) MarkUnknown(context.Context, SettlementReconciledPayload, string, time.Time) error {
	s.unknown++
	return nil
}
func (s *fakeStore) MarkSettled(context.Context, SettlementReconciledPayload, uint64, string, time.Time) error {
	s.settled++
	if s.settledFailures > 0 {
		s.settledFailures--
		return errors.New("simulated PostgreSQL crash window")
	}
	return nil
}
func (s *fakeStore) MarkEventProcessed(context.Context, string, string, time.Time) error {
	s.processed++
	return nil
}

type fakeLedger struct {
	posts int
	err   error
}

func (l *fakeLedger) PostConfirmedTransfer(context.Context, ledger.PostingRequest) (ledger.PostedTransferFact, error) {
	l.posts++
	if l.err != nil {
		return ledger.PostedTransferFact{}, l.err
	}
	return ledger.PostedTransferFact{TransferID: 1}, nil
}

func testRecord(t *testing.T, payload SettlementReconciledPayload) *eventing.Envelope {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return &eventing.Envelope{EventID: "event-1", EventType: SettlementReconciledV1, SchemaVersion: "v1", CorrelationID: payload.IntentID, Payload: raw}
}
func testRecordBytes(t *testing.T, payload SettlementReconciledPayload) []byte {
	raw, err := json.Marshal(testRecord(t, payload))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
func basePayload() SettlementReconciledPayload {
	return SettlementReconciledPayload{TenantID: "tenant-a", IntentID: "intent-a", IdempotencyKey: "idem-a", ReleaseSHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ReconciliationRunID: "recon-20260902-001", Status: "SETTLED", Asset: "USDC", AmountMinor: 100, DebitAccountID: 1, CreditAccountID: 2, ProviderFinal: true, BusinessEffect: true}
}

func TestHandleRecordConfirmedPostsAndProcesses(t *testing.T) {
	p := basePayload()
	store := &fakeStore{intent: IntentRecord{TenantID: p.TenantID, IntentID: p.IntentID, IdempotencyKey: p.IdempotencyKey, ReleaseSHA: p.ReleaseSHA, ReconciliationRunID: p.ReconciliationRunID, Status: "PENDING"}}
	ledgerClient := &fakeLedger{}
	consumer := &Consumer{Store: store, Ledger: ledgerClient, Policy: AllowAllIntentPolicy{}, Now: func() time.Time { return time.Unix(10, 0) }}
	if err := consumer.HandleRecord(context.Background(), &kgo.Record{Value: testRecordBytes(t, p)}); err != nil {
		t.Fatal(err)
	}
	if ledgerClient.posts != 1 || store.settled != 1 || store.processed != 1 || store.unknown != 0 {
		t.Fatalf("unexpected state: posts=%d settled=%d processed=%d unknown=%d", ledgerClient.posts, store.settled, store.processed, store.unknown)
	}
}

func TestHandleRecordPartialIsUnknownAndDoesNotPost(t *testing.T) {
	p := basePayload()
	p.Status = "PARTIAL"
	p.ProviderFinal = false
	p.BusinessEffect = false
	store := &fakeStore{intent: IntentRecord{TenantID: p.TenantID, IntentID: p.IntentID, IdempotencyKey: p.IdempotencyKey, ReleaseSHA: p.ReleaseSHA, ReconciliationRunID: p.ReconciliationRunID, Status: "PENDING"}}
	ledgerClient := &fakeLedger{}
	consumer := &Consumer{Store: store, Ledger: ledgerClient, Policy: AllowAllIntentPolicy{}}
	if err := consumer.HandleRecord(context.Background(), &kgo.Record{Value: testRecordBytes(t, p)}); err != nil {
		t.Fatal(err)
	}
	if ledgerClient.posts != 0 || store.unknown != 1 || store.settled != 0 {
		t.Fatalf("partial response must be UNKNOWN without posting: %+v", store)
	}
}

func TestHandleRecordRunIDMismatchIsUnknown(t *testing.T) {
	p := basePayload()
	store := &fakeStore{intent: IntentRecord{TenantID: p.TenantID, IntentID: p.IntentID, IdempotencyKey: p.IdempotencyKey, ReleaseSHA: p.ReleaseSHA, ReconciliationRunID: "different-run", Status: "PENDING"}}
	ledgerClient := &fakeLedger{}
	consumer := &Consumer{Store: store, Ledger: ledgerClient, Policy: AllowAllIntentPolicy{}}
	if err := consumer.HandleRecord(context.Background(), &kgo.Record{Value: testRecordBytes(t, p)}); err == nil {
		t.Fatal("run-ID mismatch must fail")
	}
	if ledgerClient.posts != 0 || store.unknown != 1 {
		t.Fatalf("run-ID mismatch must block and become UNKNOWN")
	}
}

func TestHandleRecordDuplicateDoesNotPostTwice(t *testing.T) {
	p := basePayload()
	store := &fakeStore{intent: IntentRecord{TenantID: p.TenantID, IntentID: p.IntentID, IdempotencyKey: p.IdempotencyKey, ReleaseSHA: p.ReleaseSHA, ReconciliationRunID: p.ReconciliationRunID, Status: "PENDING"}}
	ledgerClient := &fakeLedger{}
	consumer := &Consumer{Store: store, Ledger: ledgerClient, Policy: AllowAllIntentPolicy{}}
	record := &kgo.Record{Value: testRecordBytes(t, p)}
	if err := consumer.HandleRecord(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	if err := consumer.HandleRecord(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	if ledgerClient.posts != 1 {
		t.Fatalf("duplicate event posted %d times", ledgerClient.posts)
	}
}

func TestHandleRecordCrashAfterTigerBeetleConfirmationReplaysSameTransfer(t *testing.T) {
	p := basePayload()
	store := &fakeStore{settledFailures: 1, intent: IntentRecord{TenantID: p.TenantID, IntentID: p.IntentID, IdempotencyKey: p.IdempotencyKey, ReleaseSHA: p.ReleaseSHA, ReconciliationRunID: p.ReconciliationRunID, Status: "PENDING"}}
	ledgerClient := &fakeLedger{}
	consumer := &Consumer{Store: store, Ledger: ledgerClient, Policy: AllowAllIntentPolicy{}}
	record := &kgo.Record{Value: testRecordBytes(t, p)}
	if err := consumer.HandleRecord(context.Background(), record); err == nil {
		t.Fatal("database failure after TigerBeetle confirmation must be returned")
	}
	store.reserved = false
	if err := consumer.HandleRecord(context.Background(), record); err != nil {
		t.Fatal(err)
	}
	if ledgerClient.posts != 2 || store.settled != 2 || store.processed != 1 {
		t.Fatalf("unexpected replay state: posts=%d settled=%d processed=%d", ledgerClient.posts, store.settled, store.processed)
	}
}

func TestHandleRecordTigerBeetleErrorIsUnknown(t *testing.T) {
	p := basePayload()
	store := &fakeStore{intent: IntentRecord{TenantID: p.TenantID, IntentID: p.IntentID, IdempotencyKey: p.IdempotencyKey, ReleaseSHA: p.ReleaseSHA, ReconciliationRunID: p.ReconciliationRunID, Status: "PENDING"}}
	consumer := &Consumer{Store: store, Ledger: &fakeLedger{err: errors.New("unavailable")}, Policy: AllowAllIntentPolicy{}}
	if err := consumer.HandleRecord(context.Background(), &kgo.Record{Value: testRecordBytes(t, p)}); err == nil {
		t.Fatal("TigerBeetle failure must be returned")
	}
	if store.unknown != 1 {
		t.Fatal("TigerBeetle failure must persist UNKNOWN")
	}
}
