package eventing

// Native Kafka publishing sits beside the Dapr publisher rather than replacing
// it. Dapr is the preferred path where the platform operates its sidecars; the
// native path is required for a service that must publish in a controlled
// environment without a sidecar. Both publish the same immutable Envelope and
// both apply the same transport rule: plaintext is allowed only for an
// explicitly configured loopback development broker. A remote plaintext broker
// is refused before any network connection is attempted.

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
)

// KafkaConfig is deployment configuration for a native Kafka publisher.
//
// It deliberately does not contain a user name or password. Broker credentials
// belong in the deployment secret store and must be translated into an
// authenticated dialer by the deployment bootstrap layer, never committed as
// Go values or configuration literals. The current local Redpanda development
// broker intentionally has no SASL, so auth is activation-gated until a secret
// backed production broker is configured.
type KafkaConfig struct {
	Brokers               []string
	Topic                 string
	TLSRequired           bool
	AllowInsecureLoopback bool
	ConnectionTimeout     time.Duration
	// TLSConfig must be supplied by the deployment bootstrap when TLS is
	// required. It must set ServerName or use a verified root pool; accepting a
	// zero TLS configuration would turn TLS into encryption without identity.
	TLSConfig *tls.Config
}

func (c KafkaConfig) validate() error {
	if len(c.Brokers) == 0 {
		return errors.New("at least one Kafka broker is required")
	}
	if strings.TrimSpace(c.Topic) == "" {
		return errors.New("Kafka topic is required")
	}
	for _, broker := range c.Brokers {
		if strings.TrimSpace(broker) == "" {
			return errors.New("Kafka broker addresses must not be blank")
		}
		if _, _, err := net.SplitHostPort(broker); err != nil {
			return fmt.Errorf("Kafka broker %q must use host:port: %w", broker, err)
		}
	}
	if c.TLSRequired {
		if c.TLSConfig == nil {
			return errors.New("Kafka TLS is required but no verified TLS configuration is supplied")
		}
		if c.TLSConfig.InsecureSkipVerify { //nolint:gosec // explicitly denied
			return errors.New("Kafka TLS certificate verification must not be disabled")
		}
		return nil
	}
	if !c.AllowInsecureLoopback {
		return errors.New("Kafka TLS is required unless loopback development mode is explicitly enabled")
	}
	for _, broker := range c.Brokers {
		host, _, _ := net.SplitHostPort(broker)
		if !isLoopbackHost(host) {
			return fmt.Errorf("plaintext Kafka transport is permitted on loopback only, got %q", host)
		}
	}
	return nil
}

func isLoopbackHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}

// KafkaPublisher publishes immutable event envelopes using the Kafka protocol.
type KafkaPublisher struct {
	config KafkaConfig
	client *kgo.Client
}

// NewKafkaPublisher validates configuration and establishes the Kafka client.
// Creating a client does not authorize money movement; it only makes the event
// channel usable after deployment has explicitly activated it.
func NewKafkaPublisher(config KafkaConfig) (*KafkaPublisher, error) {
	if err := config.validate(); err != nil {
		return nil, err
	}

	options := []kgo.Opt{
		kgo.SeedBrokers(config.Brokers...),
		kgo.DefaultProduceTopic(config.Topic),
		// Broker acknowledgement is required. A local dev broker has one
		// replica; a production Kafka cluster must be configured separately
		// with its replication and min-insync policy.
		kgo.RequiredAcks(kgo.AllISRAcks()),
		kgo.RecordRetries(3),
	}
	if config.TLSRequired {
		options = append(options, kgo.DialTLSConfig(config.TLSConfig.Clone()))
	}
	if config.ConnectionTimeout > 0 {
		options = append(options, kgo.DialTimeout(config.ConnectionTimeout))
	}
	client, err := kgo.NewClient(options...)
	if err != nil {
		return nil, fmt.Errorf("create Kafka publisher: %w", err)
	}
	return &KafkaPublisher{config: config, client: client}, nil
}

// Close releases connections. It is safe to call once the publisher is no
// longer used by the service process.
func (p *KafkaPublisher) Close() {
	if p != nil && p.client != nil {
		p.client.Close()
	}
}

// Publish serialises and writes an event. The key is the correlation ID, which
// keeps the event history for one payment order ordered inside a topic
// partition. The topic passed through Publisher is intentionally checked
// against the configured topic: allowing arbitrary topic names would let an
// application caller bypass the broker's topic-level policy.
func (p *KafkaPublisher) Publish(ctx context.Context, topic string, event Envelope) error {
	if p == nil || p.client == nil {
		return errors.New("Kafka publisher is not configured")
	}
	if strings.TrimSpace(topic) != p.config.Topic {
		return fmt.Errorf("Kafka publishing is limited to configured topic %q", p.config.Topic)
	}
	if event.EventID == "" || event.EventType == "" || event.CorrelationID == "" || len(event.Payload) == 0 {
		return errors.New("event envelope is incomplete")
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		return fmt.Errorf("encode event envelope: %w", err)
	}

	result := p.client.ProduceSync(ctx, &kgo.Record{
		Topic:   p.config.Topic,
		Key:     []byte(event.CorrelationID),
		Value:   encoded,
		Headers: []kgo.RecordHeader{{Key: "ce_type", Value: []byte(event.EventType)}, {Key: "ce_specversion", Value: []byte(event.SchemaVersion)}},
	})
	if err := result.FirstErr(); err != nil {
		return fmt.Errorf("Kafka publish failed: %w", err)
	}
	return nil
}
