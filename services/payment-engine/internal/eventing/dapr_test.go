package eventing

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
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
	if err := (DaprPublisher{BaseURL: server.URL, PubsubName: "kafka", AllowInsecureLoopback: true}).Publish(context.Background(), "payment.events", event); err != nil {
		t.Fatal(err)
	}
}

func TestDaprPublisherRefusesUnsafeDestinations(t *testing.T) {
	event, err := NewOrderValidated("event-1", "order-1", time.Now(), map[string]string{"status": "APPROVED"})
	if err != nil {
		t.Fatal(err)
	}
	for _, publisher := range []DaprPublisher{
		{BaseURL: "http://dapr.example.com:3500", PubsubName: "kafka", AllowInsecureLoopback: true},
		{BaseURL: "http://token@127.0.0.1:3500", PubsubName: "kafka", AllowInsecureLoopback: true},
		{BaseURL: "ftp://127.0.0.1:3500", PubsubName: "kafka", AllowInsecureLoopback: true},
		{BaseURL: "http://127.0.0.1:3500", PubsubName: "kafka"},
	} {
		if err := publisher.Publish(context.Background(), "payment.events", event); err == nil {
			t.Fatalf("unsafe Dapr destination %+v was accepted", publisher)
		}
	}
	valid := DaprPublisher{BaseURL: "http://127.0.0.1:3500", PubsubName: "kafka", AllowInsecureLoopback: true}
	if err := valid.Publish(context.Background(), "payment/events", event); err == nil {
		t.Fatal("path-shaped topic was accepted")
	}
}

// TestLiveDaprPublishesToKafka crosses every layer in the event path: Go
// publisher -> live Dapr sidecar -> live Dapr Kafka component -> live Redpanda
// -> native Kafka consumer. The consumer sees Dapr's CloudEvents wrapper and
// verifies the original immutable envelope inside `data`.
func TestLiveDaprPublishesToKafka(t *testing.T) {
	baseURL := os.Getenv("DAPR_LIVE_BASE_URL")
	brokers := os.Getenv("KAFKA_LIVE_BROKERS")
	if baseURL == "" || brokers == "" {
		t.Skip("set DAPR_LIVE_BASE_URL and KAFKA_LIVE_BROKERS to run the live Dapr regression")
	}
	consumer, err := kgo.NewClient(
		kgo.SeedBrokers(strings.Split(brokers, ",")...),
		kgo.ConsumeTopics("payment.events"),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtEnd()),
	)
	if err != nil {
		t.Fatalf("consumer: %v", err)
	}
	defer consumer.Close()
	// Establish the fetch before publish, so the event is not missed by the
	// at-end offset reset.
	initial, cancelInitial := context.WithTimeout(context.Background(), time.Second)
	consumer.PollFetches(initial)
	cancelInitial()

	unique := time.Now().UTC().Format("20060102150405.000000000")
	correlationID := "dapr-live-" + unique
	event, err := NewOrderValidated("event-"+unique, correlationID, time.Now(), map[string]string{"status": "APPROVED"})
	if err != nil {
		t.Fatal(err)
	}
	publisher := DaprPublisher{BaseURL: baseURL, PubsubName: "kafka", AllowInsecureLoopback: true}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := publisher.Publish(ctx, "payment.events", event); err != nil {
		t.Fatalf("publish through Dapr: %v", err)
	}

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		poll, cancelPoll := context.WithTimeout(context.Background(), 3*time.Second)
		fetches := consumer.PollFetches(poll)
		cancelPoll()
		if err := fetches.Err(); err != nil && !strings.Contains(err.Error(), "context deadline") {
			t.Fatalf("consume: %v", err)
		}
		found := false
		fetches.EachRecord(func(record *kgo.Record) {
			var cloudEvent struct {
				Data Envelope `json:"data"`
			}
			if err := json.Unmarshal(record.Value, &cloudEvent); err != nil {
				t.Fatalf("decode Dapr CloudEvent: %v", err)
			}
			if cloudEvent.Data.CorrelationID == correlationID {
				if cloudEvent.Data.EventID != event.EventID || cloudEvent.Data.EventType != PaymentOrderValidatedV1 {
					t.Fatalf("event changed through Dapr: %+v", cloudEvent.Data)
				}
				found = true
			}
		})
		if found {
			return
		}
	}
	t.Fatal("event did not traverse Dapr into the live Kafka broker")
}
