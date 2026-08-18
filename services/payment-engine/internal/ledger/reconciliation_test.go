package ledger

import (
	"testing"
	"time"
)

func TestVerifyProjectionAcceptsMatchingConfirmedFact(t *testing.T) {
	posted := time.Now().UTC()
	err := VerifyProjection(
		PostedTransferFact{TransferID: 1, CorrelationID: "corr-1", Currency: "ZAR", Amount: 100, PostedAt: posted},
		ProjectionRecord{TransferID: 1, CorrelationID: "corr-1", Currency: "ZAR", Amount: 100, ProjectedAt: posted.Add(time.Second)},
	)
	if err != nil {
		t.Fatalf("expected matching projection to reconcile: %v", err)
	}
}

func TestVerifyProjectionRejectsMismatchedAmount(t *testing.T) {
	posted := time.Now().UTC()
	err := VerifyProjection(
		PostedTransferFact{TransferID: 1, CorrelationID: "corr-1", Currency: "ZAR", Amount: 100, PostedAt: posted},
		ProjectionRecord{TransferID: 1, CorrelationID: "corr-1", Currency: "ZAR", Amount: 99, ProjectedAt: posted.Add(time.Second)},
	)
	if err == nil {
		t.Fatal("expected mismatched projection to fail reconciliation")
	}
}
