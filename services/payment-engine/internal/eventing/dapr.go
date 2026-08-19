package eventing

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// DaprPublisher implements Publisher through Dapr's documented HTTP pub/sub path.
// A Kafka component is configured in Dapr deployment metadata, not in payment-engine source code.
type DaprPublisher struct {
	BaseURL, PubsubName string
	Client              *http.Client
	// Dapr normally runs as a local sidecar. This exemption permits its
	// plaintext HTTP port only on loopback and only when a deployment has
	// explicitly selected it. A remote plaintext Dapr endpoint is refused.
	AllowInsecureLoopback bool
}

func (p DaprPublisher) Publish(ctx context.Context, topic string, event Envelope) error {
	if strings.TrimSpace(p.BaseURL) == "" || !safeDaprSegment(p.PubsubName) {
		return errors.New("dapr pubsub is not configured")
	}
	if !safeDaprSegment(topic) {
		return errors.New("event topic must be a single non-empty path segment")
	}
	base, err := url.Parse(p.BaseURL)
	if err != nil || base.Scheme == "" || base.Host == "" {
		return errors.New("dapr base URL must be an absolute URL")
	}
	if base.User != nil {
		return errors.New("dapr base URL must not embed credentials")
	}
	if base.Scheme == "http" {
		if !p.AllowInsecureLoopback {
			return errors.New("dapr plaintext transport requires the explicit loopback exemption")
		}
		if !loopbackDaprHost(base.Hostname()) {
			return fmt.Errorf("dapr plaintext transport is permitted on loopback only, got %q", base.Hostname())
		}
	} else if base.Scheme != "https" {
		return fmt.Errorf("unsupported dapr URL scheme %q", base.Scheme)
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

func safeDaprSegment(value string) bool {
	return strings.TrimSpace(value) != "" && !strings.ContainsAny(value, "/?#") && !strings.Contains(value, "..")
}

func loopbackDaprHost(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
