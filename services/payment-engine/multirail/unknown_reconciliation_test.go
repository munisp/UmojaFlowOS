package multirail

import (
	"context"
	"testing"
	"time"
)

type reconciliationStore struct {
	state     UnknownState
	claimed   bool
	decisions []ReconciliationResult
	resched   []time.Time
}

func (s *reconciliationStore) Claim(context.Context, string, time.Time) (UnknownState, bool, error) {
	if s.claimed {
		return UnknownState{}, false, nil
	}
	s.claimed = true
	s.state.Attempts++
	return s.state, true, nil
}
func (s *reconciliationStore) RecordDecision(_ context.Context, result ReconciliationResult) error {
	s.decisions = append(s.decisions, result)
	return nil
}
func (s *reconciliationStore) Reschedule(_ context.Context, _ UnknownState, next time.Time, _ string) error {
	s.resched = append(s.resched, next)
	return nil
}

type reconciliationRail struct{ query Submission; queryErr error; submitCalls int }
func (r *reconciliationRail) Name() string { return "yellow_card" }
func (r *reconciliationRail) Submit(context.Context, Intent) (Submission, error) { r.submitCalls++; return Submission{}, nil }
func (r *reconciliationRail) Query(context.Context, Intent) (Submission, error) { return r.query, r.queryErr }

func TestQueryFailedWithoutExplicitSafeRetryBlocksFallback(t *testing.T) {
	primary := &fakeRail{name: "yellow_card", submitErr: context.DeadlineExceeded, query: Submission{Status: Failed, RetryableWithoutBusinessEffect: false}}
	secondary := &fakeRail{name: "bank", submit: Submission{Status: Submitted}}
	_, err := NewCoordinator().Execute(context.Background(), Intent{ID: "query-unsafe", IdempotencyKey: "query-unsafe-key"}, primary, secondary)
	if err != ErrUnknownOutcome || secondary.calls != 0 {
		t.Fatalf("err=%v secondary_calls=%d", err, secondary.calls)
	}
}

func TestUnknownReconciliationAcceptedProviderOutcomeNeverAuthorizesSettlement(t *testing.T) {
	store := &reconciliationStore{state: UnknownState{Intent: Intent{ID: "i1", IdempotencyKey: "k1"}, PrimaryRail: "yellow_card", ProviderRef: "yc-1"}}
	provider := &reconciliationRail{query: Submission{Status: Settled, ProviderRef: "yc-1"}}
	worker := ReconciliationWorker{Store: store, Now: func() time.Time { return time.Unix(100, 0).UTC() }}
	result, err := worker.Reconcile(context.Background(), "k1", provider)
	if err != nil || result.Decision != DecisionProviderAccepted || result.SettlementAllowed {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if provider.submitCalls != 0 || len(store.decisions) != 1 || len(store.resched) != 0 {
		t.Fatalf("submit_calls=%d decisions=%d reschedules=%d", provider.submitCalls, len(store.decisions), len(store.resched))
	}
}

func TestUnknownReconciliationReschedulesInconclusiveProvider(t *testing.T) {
	store := &reconciliationStore{state: UnknownState{Intent: Intent{ID: "i2", IdempotencyKey: "k2"}, PrimaryRail: "yellow_card", Attempts: 1}}
	provider := &reconciliationRail{query: Submission{Status: Unknown}}
	worker := ReconciliationWorker{Store: store, Now: func() time.Time { return time.Unix(100, 0).UTC() }, RetryAfter: time.Second}
	result, err := worker.Reconcile(context.Background(), "k2", provider)
	if err != ErrReconciliationUnavailable || result.Decision != DecisionAwaitingEvidence || len(store.resched) != 1 {
		t.Fatalf("result=%+v err=%v reschedules=%d", result, err, len(store.resched))
	}
	if result.SettlementAllowed || provider.submitCalls != 0 {
		t.Fatalf("unsafe reconciliation side effect: result=%+v submit_calls=%d", result, provider.submitCalls)
	}
}

func TestUnknownReconciliationConfirmedNonSubmissionDoesNotSubmitSecondary(t *testing.T) {
	store := &reconciliationStore{state: UnknownState{Intent: Intent{ID: "i3", IdempotencyKey: "k3"}, PrimaryRail: "yellow_card"}}
	provider := &reconciliationRail{query: Submission{Status: Failed, RetryableWithoutBusinessEffect: true}}
	worker := ReconciliationWorker{Store: store, Now: func() time.Time { return time.Unix(100, 0).UTC() }}
	result, err := worker.Reconcile(context.Background(), "k3", provider)
	if err != nil || result.Decision != DecisionConfirmedNonSubmission || result.SettlementAllowed {
		t.Fatalf("result=%+v err=%v", result, err)
	}
	if len(store.decisions) != 1 || provider.submitCalls != 0 {
		t.Fatalf("unexpected effects: decisions=%d submit_calls=%d", len(store.decisions), provider.submitCalls)
	}
}
