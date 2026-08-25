package provider

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/ledger"
)

type staticReferenceVerifier struct {
	reference YellowCardProviderReference
	err       error
}

func (v staticReferenceVerifier) VerifyYellowCardReference(context.Context, WebhookEvidence) (YellowCardProviderReference, error) {
	return v.reference, v.err
}

type staticLedgerEvidence struct {
	transfer   ledger.PostedTransferFact
	projection ledger.ProjectionRecord
	err        error
}

func (e staticLedgerEvidence) ResolveLedgerEvidence(context.Context, YellowCardProviderReference) (ledger.PostedTransferFact, ledger.ProjectionRecord, error) {
	return e.transfer, e.projection, e.err
}

type recordingDecisionStore struct{ decisions []ReconciliationDecision }

func (s *recordingDecisionStore) RecordReconciliationDecision(_ context.Context, decision ReconciliationDecision) error {
	s.decisions = append(s.decisions, decision)
	return nil
}

func pendingWebhookEvidence() WebhookEvidence {
	return WebhookEvidence{
		Provider:       "yellowcard",
		EventID:        "event-001",
		SequenceID:     "sequence-001",
		Status:         "completed",
		Reconciliation: "pending_independent_provider_and_ledger_reconciliation",
	}
}

func TestYellowCardReconciliationRequiresAgreementAndNeverSettles(t *testing.T) {
	store := &recordingDecisionStore{}
	at := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	reconciler := YellowCardReconciler{
		Provider: staticReferenceVerifier{reference: YellowCardProviderReference{EventID: "event-001", SequenceID: "sequence-001", Status: "completed", CorrelationID: "corr-001", VerifiedAt: at}},
		Ledger: staticLedgerEvidence{
			transfer:   ledger.PostedTransferFact{TransferID: 22, CorrelationID: "corr-001", Currency: "USDC", Amount: 100, PostedAt: at},
			projection: ledger.ProjectionRecord{TransferID: 22, CorrelationID: "corr-001", Currency: "USDC", Amount: 100, ProjectedAt: at.Add(time.Second)},
		},
		Store: store,
		Now:   func() time.Time { return at.Add(2 * time.Second) },
	}
	decision, err := reconciler.Reconcile(context.Background(), pendingWebhookEvidence())
	if err != nil {
		t.Fatal(err)
	}
	if decision.Decision != "reconciled_without_settlement_authority" || decision.SettlementAllowed || len(store.decisions) != 1 {
		t.Fatalf("reconciliation granted unexpected authority or failed to record evidence: %#v", decision)
	}
}

func TestYellowCardReconciliationRejectsProviderMismatch(t *testing.T) {
	store := &recordingDecisionStore{}
	reconciler := YellowCardReconciler{
		Provider: staticReferenceVerifier{reference: YellowCardProviderReference{EventID: "other", SequenceID: "sequence-001", Status: "completed", CorrelationID: "corr-001", VerifiedAt: webhookFixedNow}},
		Ledger:   staticLedgerEvidence{},
		Store:    store,
	}
	if _, err := reconciler.Reconcile(context.Background(), pendingWebhookEvidence()); err == nil {
		t.Fatal("expected provider mismatch to fail")
	}
	if len(store.decisions) != 0 {
		t.Fatal("provider mismatch must not record a reconciliation decision")
	}
}

func TestYellowCardReconciliationRejectsLedgerMismatch(t *testing.T) {
	store := &recordingDecisionStore{}
	reconciler := YellowCardReconciler{
		Provider: staticReferenceVerifier{reference: YellowCardProviderReference{EventID: "event-001", SequenceID: "sequence-001", Status: "completed", CorrelationID: "corr-001", VerifiedAt: webhookFixedNow}},
		Ledger: staticLedgerEvidence{
			transfer:   ledger.PostedTransferFact{TransferID: 22, CorrelationID: "corr-001", Currency: "USDC", Amount: 100, PostedAt: webhookFixedNow},
			projection: ledger.ProjectionRecord{TransferID: 22, CorrelationID: "different", Currency: "USDC", Amount: 100, ProjectedAt: webhookFixedNow.Add(time.Second)},
		},
		Store: store,
	}
	if _, err := reconciler.Reconcile(context.Background(), pendingWebhookEvidence()); err == nil {
		t.Fatal("expected ledger mismatch to fail")
	}
	if len(store.decisions) != 0 {
		t.Fatal("ledger mismatch must not record a reconciliation decision")
	}
}

func TestYellowCardReconciliationRejectsUnavailableDependencies(t *testing.T) {
	reconciler := YellowCardReconciler{
		Provider: staticReferenceVerifier{err: errors.New("provider unavailable")},
		Ledger:   staticLedgerEvidence{},
		Store:    &recordingDecisionStore{},
	}
	if _, err := reconciler.Reconcile(context.Background(), pendingWebhookEvidence()); err == nil {
		t.Fatal("expected unavailable provider verifier to fail closed")
	}
}
