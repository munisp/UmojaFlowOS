package ledger

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// HTTPProjectionSink sends a confirmed TigerBeetle fact to the control plane
// over a private authenticated route. Its request is HMAC-authenticated with a
// secret injected into both runtimes; the route records evidence only and owns
// all PostgreSQL writes.
type HTTPProjectionSink struct {
	endpoint *url.URL
	secret   []byte
	client   *http.Client
	now      func() time.Time
}

type HTTPProjectionSinkConfig struct {
	Endpoint              string
	SharedSecret          []byte
	HTTPClient            *http.Client
	Now                   func() time.Time
	AllowInsecureLoopback bool
}

func isLoopbackProjectionHost(host string) bool {
	host = strings.TrimSpace(strings.ToLower(host))
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func NewHTTPProjectionSink(config HTTPProjectionSinkConfig) (*HTTPProjectionSink, error) {
	endpoint, err := url.Parse(strings.TrimSpace(config.Endpoint))
	if err != nil || endpoint.Scheme == "" || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, errors.New("ledger projection endpoint must be an absolute credential-free URL")
	}
	if endpoint.Path != "/internal/ledger/projections" {
		return nil, errors.New("ledger projection endpoint must use the fixed internal projection path")
	}
	if endpoint.Scheme != "https" && !(endpoint.Scheme == "http" && config.AllowInsecureLoopback && isLoopbackProjectionHost(endpoint.Hostname())) {
		return nil, errors.New("ledger projection endpoint must use HTTPS unless explicit loopback development transport is enabled")
	}
	if len(config.SharedSecret) < 16 {
		return nil, errors.New("ledger projection shared secret is required")
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	now := config.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &HTTPProjectionSink{endpoint: endpoint, secret: append([]byte(nil), config.SharedSecret...), client: client, now: now}, nil
}

type projectionRequest struct {
	TransferID      string `json:"transfer_id"`
	CorrelationID   string `json:"correlation_id"`
	Currency        string `json:"currency"`
	AmountMinor     string `json:"amount_minor"`
	DebitAccountID  string `json:"debit_account_id"`
	CreditAccountID string `json:"credit_account_id"`
	PostedAt        string `json:"posted_at"`
	EvidenceSHA256  string `json:"evidence_sha256"`
}

func (s *HTTPProjectionSink) ProjectPostedTransfer(ctx context.Context, fact PostedTransferFact) error {
	if s == nil || s.endpoint == nil || len(s.secret) < 16 {
		return errors.New("ledger projection sink is not configured")
	}
	if fact.DebitAccountID == 0 || fact.CreditAccountID == 0 {
		return errors.New("confirmed transfer requires debit and credit account evidence")
	}
	canonical := fmt.Sprintf("%d|%s|%s|%d|%d|%d|%s", fact.TransferID, fact.CorrelationID, fact.Currency, fact.Amount, fact.DebitAccountID, fact.CreditAccountID, fact.PostedAt.UTC().Format(time.RFC3339Nano))
	evidenceDigest := sha256.Sum256([]byte(canonical))
	payload, err := json.Marshal(projectionRequest{
		TransferID: strconv.FormatUint(fact.TransferID, 10), CorrelationID: fact.CorrelationID, Currency: fact.Currency, AmountMinor: strconv.FormatUint(fact.Amount, 10),
		DebitAccountID: strconv.FormatUint(fact.DebitAccountID, 10), CreditAccountID: strconv.FormatUint(fact.CreditAccountID, 10),
		PostedAt: fact.PostedAt.UTC().Format(time.RFC3339Nano), EvidenceSHA256: fmt.Sprintf("%x", evidenceDigest[:]),
	})
	if err != nil {
		return fmt.Errorf("encode ledger projection: %w", err)
	}
	timestamp := s.now().UTC().Format(time.RFC3339Nano)
	bodyDigest := sha256.Sum256(payload)
	message := []byte(timestamp + http.MethodPost + s.endpoint.EscapedPath() + base64.StdEncoding.EncodeToString(bodyDigest[:]))
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write(message)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("create ledger projection request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Umoja-Internal-Timestamp", timestamp)
	request.Header.Set("X-Umoja-Internal-Signature", base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	response, err := s.client.Do(request)
	if err != nil {
		return errors.New("ledger projection endpoint is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated && response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return fmt.Errorf("ledger projection endpoint returned HTTP %d", response.StatusCode)
	}
	return nil
}
