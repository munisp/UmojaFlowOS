package settlement

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/eventing"
)

// OutboxStore is deliberately smaller than SagaStore to support independently
// scaled publishers without granting them authority to mutate saga state.
type OutboxStore interface {
	ClaimOutbox(context.Context, string, string, int, time.Duration) ([]OutboxEvent, error)
	MarkOutboxPublished(context.Context, string, string, string) error
}

// OutboxWorker publishes only records committed by PostgresSagaStore. Kafka,
// Dapr, Temporal or Fluvio consumers may receive duplicates after a publisher
// crash; each consumer must reserve its tenant-scoped inbox key before acting.
type OutboxWorker struct {
	Store     OutboxStore
	Publisher eventing.Publisher
	Topic     string
	Owner     string
	BatchSize int
	Lease     time.Duration
}

func (w OutboxWorker) PublishOnce(ctx context.Context, tenantID string) (int, error) {
	if w.Store == nil || w.Publisher == nil || strings.TrimSpace(w.Topic) == "" || strings.TrimSpace(w.Owner) == "" || w.BatchSize <= 0 || w.Lease <= 0 {
		return 0, errors.New("outbox store, publisher, topic, owner, batch size, and lease are required")
	}
	events, err := w.Store.ClaimOutbox(ctx, tenantID, w.Owner, w.BatchSize, w.Lease)
	if err != nil {
		return 0, err
	}
	published := 0
	for _, event := range events {
		if err := validateOutboxEvent(event, tenantID); err != nil {
			return published, err
		}
		envelope := eventing.Envelope{EventID: event.EventID, EventType: event.EventType, SchemaVersion: "v1", OccurredAt: event.AvailableAt.UTC(), CorrelationID: event.SagaID, Payload: event.Payload}
		if err := w.Publisher.Publish(ctx, w.Topic, envelope); err != nil {
			// The database lease remains active until expiration. A transport error
			// never marks the event published and cannot erase the durable intent.
			return published, err
		}
		if err := w.Store.MarkOutboxPublished(ctx, event.TenantID, event.EventID, w.Owner); err != nil {
			// The broker may redeliver the event; tenant/source/message inbox
			// de-duplication is required downstream before any side effect.
			return published, err
		}
		published++
	}
	return published, nil
}

func validateOutboxEvent(event OutboxEvent, requestedTenant string) error {
	if strings.TrimSpace(requestedTenant) == "" || event.TenantID != requestedTenant || strings.TrimSpace(event.EventID) == "" || strings.TrimSpace(event.SagaID) == "" || strings.TrimSpace(event.EventType) == "" || len(event.Payload) == 0 || !validDigest(event.PayloadSHA256) {
		return errors.New("invalid tenant-scoped settlement outbox event")
	}
	digest := sha256.Sum256(event.Payload)
	if hex.EncodeToString(digest[:]) != event.PayloadSHA256 {
		return errors.New("settlement outbox payload digest mismatch")
	}
	return nil
}
