package eventing

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

const PaymentOrderValidatedV1 = "umojaflowos.payment.order.validated.v1"
const PaymentOrderWorkflowRecordedV1 = "umojaflowos.payment.order.workflow-recorded.v1"
const PermifyDecisionV1 = "umojaflowos.authorization.permify-decision.v1"

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

// NewWorkflowOutcome creates non-authoritative evidence of a durable workflow
// decision. The workflow ID stays inside the internal event transport as its
// correlation reference; analytics applies a second SHA-256 transformation at
// the catalog boundary. No provider result, amount, beneficiary, or execution
// instruction is represented in this event.
func NewWorkflowOutcome(workflowID, status string, occurredAt time.Time, executionStarted bool) (Envelope, error) {
	if workflowID == "" || status == "" {
		return Envelope{}, errors.New("workflow id and status are required")
	}
	payload, err := json.Marshal(struct {
		Status           string `json:"status"`
		ExecutionStarted bool   `json:"execution_started"`
	}{Status: status, ExecutionStarted: executionStarted})
	if err != nil {
		return Envelope{}, err
	}
	digest := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%s", workflowID, status, occurredAt.UTC().Format(time.RFC3339Nano))))
	return Envelope{
		EventID:       fmt.Sprintf("workflow-%x", digest[:]),
		EventType:     PaymentOrderWorkflowRecordedV1,
		SchemaVersion: "v1",
		OccurredAt:    occurredAt.UTC(),
		CorrelationID: workflowID,
		Payload:       payload,
	}, nil
}

// NewPermifyDecision records only the decision class as internal evidence. The
// resource reference stays inside the event transport and is transformed to a
// SHA-256 correlation at the lakehouse boundary; policy relationships and
// reasons are not exported for analytics.
func NewPermifyDecision(subjectID, entityID, permission string, allowed bool, occurredAt time.Time) (Envelope, error) {
	if subjectID == "" || entityID == "" || permission == "" {
		return Envelope{}, errors.New("authorization subject, entity, and permission are required")
	}
	decision := "denied"
	if allowed {
		decision = "allowed"
	}
	payload, err := json.Marshal(struct {
		Decision string `json:"decision"`
	}{Decision: decision})
	if err != nil {
		return Envelope{}, err
	}
	digest := sha256.Sum256([]byte(fmt.Sprintf("%s|%s|%s|%s", subjectID, entityID, permission, occurredAt.UTC().Format(time.RFC3339Nano))))
	return Envelope{
		EventID:       fmt.Sprintf("permify-%x", digest[:]),
		EventType:     PermifyDecisionV1,
		SchemaVersion: "v1",
		OccurredAt:    occurredAt.UTC(),
		CorrelationID: entityID,
		Payload:       payload,
	}, nil
}

// Publisher is implemented by a Kafka producer or a Dapr pub/sub adapter. The payment engine owns no broker credentials.
type Publisher interface {
	Publish(context.Context, string, Envelope) error
}

type DisabledPublisher struct{}

func (DisabledPublisher) Publish(context.Context, string, Envelope) error {
	return errors.New("event transport is disabled until Kafka or Dapr is deployed and authorised")
}
