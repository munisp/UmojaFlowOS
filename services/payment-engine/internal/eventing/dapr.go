package eventing

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// DaprPublisher implements Publisher through Dapr's documented HTTP pub/sub path.
// A Kafka component is configured in Dapr deployment metadata, not in payment-engine source code.
type DaprPublisher struct {
	BaseURL, PubsubName string
	Client              *http.Client
}

func (p DaprPublisher) Publish(ctx context.Context, topic string, event Envelope) error {
	if strings.TrimSpace(p.BaseURL) == "" || strings.TrimSpace(p.PubsubName) == "" {
		return errors.New("dapr pubsub is not configured")
	}
	if strings.TrimSpace(topic) == "" {
		return errors.New("event topic is required")
	}
	base, err := url.Parse(p.BaseURL)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return errors.New("dapr base URL must be an absolute URL")
	}
	endpoint := strings.TrimRight(base.String(), "/") + "/v1.0/publish/" + url.PathEscape(p.PubsubName) + "/" + url.PathEscape(topic)
	body, err := json.Marshal(event)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := p.Client
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("dapr publish failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("dapr publish returned status %d", resp.StatusCode)
	}
	return nil
}
