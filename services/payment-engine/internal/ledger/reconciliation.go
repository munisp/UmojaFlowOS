package ledger

import (
	"errors"
	"time"
)

type ProjectionRecord struct {
	TransferID    uint64
	CorrelationID string
	Currency      string
	Amount        uint64
	ProjectedAt   time.Time
}

func VerifyProjection(fact PostedTransferFact, projection ProjectionRecord) error {
	if fact.TransferID == 0 || fact.CorrelationID == "" || fact.Currency == "" || fact.Amount == 0 || fact.PostedAt.IsZero() {
		return errors.New("complete confirmed tigerbeetle transfer evidence is required for reconciliation")
	}
	if projection.TransferID == 0 || projection.CorrelationID == "" || projection.Currency == "" || projection.Amount == 0 || projection.ProjectedAt.IsZero() {
		return errors.New("complete postgres projection evidence is required for reconciliation")
	}
	if fact.TransferID != projection.TransferID || fact.CorrelationID != projection.CorrelationID || fact.Currency != projection.Currency || fact.Amount != projection.Amount {
		return errors.New("tigerbeetle fact and postgres projection do not reconcile")
	}
	if projection.ProjectedAt.Before(fact.PostedAt) {
		return errors.New("postgres projection predates confirmed tigerbeetle posting")
	}
	return nil
}
