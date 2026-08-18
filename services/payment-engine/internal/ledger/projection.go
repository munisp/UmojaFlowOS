package ledger

import (
	"context"
	"errors"
	"time"
)

// PostedTransferFact is emitted only after TigerBeetle has accepted a balanced transfer.
// It is a projection command, never authority to create a monetary transfer in PostgreSQL.
type PostedTransferFact struct {
	TransferID    uint64
	CorrelationID string
	Currency      string
	Amount        uint64
	PostedAt      time.Time
}

type ProjectionSink interface {
	ProjectPostedTransfer(context.Context, PostedTransferFact) error
}

type DisabledProjectionSink struct{}

func (DisabledProjectionSink) ProjectPostedTransfer(context.Context, PostedTransferFact) error {
	return errors.New("postgres ledger projection is disabled until tigerbeetle posting and reconciliation are configured")
}

func ProjectConfirmedTransfer(ctx context.Context, sink ProjectionSink, fact PostedTransferFact) error {
	if fact.TransferID == 0 || fact.CorrelationID == "" || fact.Currency == "" || fact.Amount == 0 || fact.PostedAt.IsZero() {
		return errors.New("complete confirmed tigerbeetle transfer evidence is required for projection")
	}
	if sink == nil {
		return errors.New("postgres projection sink is not configured")
	}
	return sink.ProjectPostedTransfer(ctx, fact)
}
