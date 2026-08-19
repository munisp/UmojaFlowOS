package eventing

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

func TestKafkaConfigurationFailsClosed(t *testing.T) {
	if _, err := NewKafkaPublisher(KafkaConfig{Topic: "payment.events"}); err == nil {
		t.Fatal("a publisher without brokers must be refused")
	}
	if _, err := NewKafkaPublisher(KafkaConfig{Brokers: []string{"broker.example.com:9092"}, Topic: "payment.events"}); err == nil {
		t.Fatal("remote plaintext Kafka must be refused")
	}
	if _, err := NewKafkaPublisher(KafkaConfig{
		Brokers: []string{"broker.example.com:9092"}, Topic: "payment.events", TLSRequired: true,
	}); err == nil {
		t.Fatal("TLS without a verified configuration must be refused")
	}
	if _, err := NewKafkaPublisher(KafkaConfig{
		Brokers: []string{"broker.example.com:9092"}, Topic: "payment.events", TLSRequired: true,
		TLSConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // negative control
	}); err == nil {
		t.Fatal("certificate verification must not be disabled")
	}
	if _, err := NewKafkaPublisher(KafkaConfig{
		Brokers: []string{"127.0.0.1:9092"}, Topic: "payment.events", AllowInsecureLoopback: true,
	}); err != nil {
		t.Fatalf("explicit loopback development configuration should be valid: %v", err)
	}
}

func TestKafkaPublisherLimitsTopicsAndRefusesIncompleteEvents(t *testing.T) {
	publisher, err := NewKafkaPublisher(KafkaConfig{
		Brokers: []string{"127.0.0.1:9092"}, Topic: "payment.events", AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatalf("construct publisher: %v", err)
	}
	defer publisher.Close()

	if err := publisher.Publish(context.Background(), "another.topic", Envelope{}); err == nil || !strings.Contains(err.Error(), "limited") {
		t.Fatalf("arbitrary topic must be refused before publish, got %v", err)
	}
	if err := publisher.Publish(context.Background(), "payment.events", Envelope{}); err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("incomplete event must be refused before publish, got %v", err)
	}
}

// TestLiveKafkaRoundTrip exercises the actual Kafka protocol against Redpanda,
// a Kafka-compatible broker. No test server or substituted publisher is used:
// a consumer joins the broker, the real publisher produces, and this test
// verifies that the correlation key and immutable envelope survive the trip.
func TestLiveKafkaRoundTrip(t *testing.T) {
	brokers := os.Getenv("KAFKA_LIVE_BROKERS")
	if brokers == "" {
		t.Skip("set KAFKA_LIVE_BROKERS to run the live Kafka round trip")
	}

	unique := time.Now().UTC().Format("20060102150405.000000000")
	correlationID := "order-live-" + unique
	consumer, err := kgo.NewClient(
		kgo.SeedBrokers(strings.Split(brokers, ",")...),
		kgo.ConsumeTopics("payment.events"),
		kgo.ConsumeResetOffset(kgo.NewOffset().AtEnd()),
	)
	if err != nil {
		t.Fatalf("create consumer: %v", err)
	}
	defer consumer.Close()

	// Force the consumer to establish its fetch before producing. The first
	// empty poll is acceptable; a non-empty prior history is ignored by the
	// correlation-ID filter below.
	pollCtx, cancelPoll := context.WithTimeout(context.Background(), 2*time.Second)
	consumer.PollFetches(pollCtx)
	cancelPoll()

	publisher, err := NewKafkaPublisher(KafkaConfig{
		Brokers: strings.Split(brokers, ","), Topic: "payment.events", AllowInsecureLoopback: true,
	})
	if err != nil {
		t.Fatalf("create publisher: %v", err)
	}
	defer publisher.Close()

	event, err := NewOrderValidated("event-live-"+unique, correlationID, time.Now(), map[string]string{"status": "APPROVED"})
	if err != nil {
		t.Fatalf("create event: %v", err)
	}
	produceCtx, cancelProduce := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancelProduce()
	if err := publisher.Publish(produceCtx, "payment.events", event); err != nil {
		t.Fatalf("publish: %v", err)
	}

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		fetches := consumer.PollFetches(ctx)
		cancel()
		if err := fetches.Err(); err != nil && !strings.Contains(err.Error(), "context deadline") {
			t.Fatalf("consume: %v", err)
		}
		var found bool
		fetches.EachRecord(func(record *kgo.Record) {
			if string(record.Key) != correlationID {
				return
			}
			var received Envelope
			if err := json.Unmarshal(record.Value, &received); err != nil {
				t.Fatalf("decode received event: %v", err)
			}
			if received.EventID != event.EventID || received.EventType != PaymentOrderValidatedV1 || received.CorrelationID != correlationID {
				t.Fatalf("event changed in transit: %+v", received)
			}
			found = true
		})
		if found {
			return
		}
	}
	t.Fatal("did not consume the event written to the live broker")
}
