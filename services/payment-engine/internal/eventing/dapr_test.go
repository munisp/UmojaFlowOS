package eventing

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDaprPublisherPostsEnvelopeToConfiguredPubsub(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1.0/publish/kafka/payment.events" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Fatal("expected POST")
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	event, err := NewOrderValidated("event-1", "order-1", time.Now(), map[string]string{"status": "APPROVED"})
	if err != nil {
		t.Fatal(err)
	}
	if err := (DaprPublisher{BaseURL: server.URL, PubsubName: "kafka"}).Publish(context.Background(), "payment.events", event); err != nil {
		t.Fatal(err)
	}
}
