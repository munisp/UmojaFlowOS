package multirail

import (
	"context"
	"testing"
	"time"
)

func safeRecoveryEvidence() RecoveryEvidence {
	return RecoveryEvidence{
		ReleaseSHA:                 "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ReconciliationRunID:        "recovery-run-20260902",
		TigerBeetleQuorumHealthy:   true,
		TigerBeetleViewsConverged:  true,
		PostgresPrimaryTrusted:     true,
		PostgresProjectionMismatch: 0,
		KafkaLagRecords:            0,
		KafkaLagLimit:              100,
		SettlementFenceActive:      true,
		CapturedAt:                 time.Unix(100, 0).UTC(),
	}
}

func TestRecoveryEvidenceRejectsUnsafeState(t *testing.T) {
	cases := []struct {
		name string
		edit func(*RecoveryEvidence)
	}{
		{"quorum lost", func(e *RecoveryEvidence) { e.TigerBeetleQuorumHealthy = false }},
		{"projection mismatch", func(e *RecoveryEvidence) { e.PostgresProjectionMismatch = 1 }},
		{"lag over limit", func(e *RecoveryEvidence) { e.KafkaLagRecords = 101 }},
		{"fence inactive", func(e *RecoveryEvidence) { e.SettlementFenceActive = false }},
		{"run mismatch", func(e *RecoveryEvidence) { e.ReconciliationRunID = "different-run" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := safeRecoveryEvidence()
			tc.edit(&e)
			if err := e.Validate(e.ReleaseSHA, "recovery-run-20260902", time.Unix(100, 0).UTC()); err == nil {
				t.Fatal("unsafe recovery evidence was accepted")
			}
		})
	}
}

func TestRecoveryEvidenceRequiresExpectedReleaseAndRun(t *testing.T) {
	e := safeRecoveryEvidence()
	if err := e.Validate("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", e.ReconciliationRunID, time.Unix(100, 0).UTC()); err == nil {
		t.Fatal("release mismatch was accepted")
	}
	if err := e.Validate(e.ReleaseSHA, "wrong-run-20260902", time.Unix(100, 0).UTC()); err == nil {
		t.Fatal("run mismatch was accepted")
	}
}

func TestPostRecoveryReconcilerDoesNotSubmit(t *testing.T) {
	store := &reconciliationStore{state: UnknownState{Intent: Intent{ID: "i1", IdempotencyKey: "k1"}, PrimaryRail: "primary", Attempts: 1}}
	provider := &reconciliationRail{query: Submission{Status: Settled, ProviderRef: "p1"}}
	e := safeRecoveryEvidence()
	reconciler := PostRecoveryReconciler{
		Worker:   ReconciliationWorker{Store: store, Now: func() time.Time { return time.Unix(100, 0).UTC() }},
		Evidence: e, ExpectedReleaseSHA: e.ReleaseSHA, ExpectedRunID: e.ReconciliationRunID,
		Now: func() time.Time { return time.Unix(100, 0).UTC() },
	}
	result, err := reconciler.Reconcile(context.Background(), "k1", provider)
	if err != nil || result.SettlementAllowed || provider.submitCalls != 0 {
		t.Fatalf("post-recovery reconciliation was unsafe: result=%+v err=%v submits=%d", result, err, provider.submitCalls)
	}
}
