package eventing

import (
	"context"
	"testing"
	"time"
)

func TestEnvelopeRequiresTraceabilityAndDisabledTransportFailsClosed(t *testing.T) {
	if _, err := NewOrderValidated("", "order-1", time.Now(), map[string]string{}); err == nil {
		t.Fatal("missing event id accepted")
	}
	event, err := NewOrderValidated("event-1", "order-1", time.Now(), map[string]string{"status": "APPROVED"})
	if err != nil {
		t.Fatal(err)
	}
	if err := (DisabledPublisher{}).Publish(context.Background(), "payment.events", event); err == nil {
		t.Fatal("disabled transport published")
	}
}
