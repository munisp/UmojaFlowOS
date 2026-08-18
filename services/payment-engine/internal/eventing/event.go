package eventing

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

const PaymentOrderValidatedV1 = "umojaflowos.payment.order.validated.v1"

type Envelope struct {
	EventID       string          `json:"event_id"`
	EventType     string          `json:"event_type"`
	SchemaVersion string          `json:"schema_version"`
	OccurredAt    time.Time       `json:"occurred_at"`
	CorrelationID string          `json:"correlation_id"`
	Payload       json.RawMessage `json:"payload"`
}

func NewOrderValidated(eventID, correlationID string, occurredAt time.Time, payload any) (Envelope, error) {
	if eventID == "" || correlationID == "" {
		return Envelope{}, errors.New("event and correlation ids are required")
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return Envelope{}, err
	}
	return Envelope{EventID: eventID, EventType: PaymentOrderValidatedV1, SchemaVersion: "v1", OccurredAt: occurredAt.UTC(), CorrelationID: correlationID, Payload: encoded}, nil
}

// Publisher is implemented by a Kafka producer or a Dapr pub/sub adapter. The payment engine owns no broker credentials.
type Publisher interface {
	Publish(context.Context, string, Envelope) error
}

type DisabledPublisher struct{}

func (DisabledPublisher) Publish(context.Context, string, Envelope) error {
	return errors.New("event transport is disabled until Kafka or Dapr is deployed and authorised")
}
