package ledger

import (
	"context"
	"testing"
	"time"
)

func TestConfirmedTransferProjectionFailsClosedWithoutSink(t *testing.T) {
	err := ProjectConfirmedTransfer(context.Background(), nil, PostedTransferFact{TransferID: 1, CorrelationID: "corr-1", Currency: "NGN", Amount: 1, PostedAt: time.Now()})
	if err == nil {
		t.Fatal("expected missing projection sink to fail closed")
	}
}

func TestDisabledProjectionSinkRejectsProjection(t *testing.T) {
	err := ProjectConfirmedTransfer(context.Background(), DisabledProjectionSink{}, PostedTransferFact{TransferID: 1, CorrelationID: "corr-1", Currency: "NGN", Amount: 1, PostedAt: time.Now()})
	if err == nil {
		t.Fatal("expected disabled projection sink to reject projection")
	}
}
