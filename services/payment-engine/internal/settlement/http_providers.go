package settlement

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type HTTPProviderConfig struct {
	BaseURL       string
	Token         string
	WebhookSecret string
	Client        *http.Client
}

func validateHTTPConfig(cfg HTTPProviderConfig) error {
	if strings.TrimSpace(cfg.BaseURL) == "" {
		return errors.New("provider base URL is required")
	}
	if !strings.HasPrefix(cfg.BaseURL, "https://") && !strings.HasPrefix(cfg.BaseURL, "http://127.0.0.1") && !strings.HasPrefix(cfg.BaseURL, "http://localhost") {
		return errors.New("provider base URL must use HTTPS outside local development")
	}
	if cfg.Client == nil {
		return errors.New("provider HTTP client is required")
	}
	return nil
}

type providerEnvelope struct {
	Reference              string `json:"reference"`
	State                  State  `json:"state"`
	Reason                 string `json:"reason"`
	BlockchainTx           string `json:"blockchain_tx,omitempty"`
	RetryableWithoutEffect bool   `json:"retryable_without_effect,omitempty"`
	Digest                 string `json:"digest,omitempty"`
	Final                  bool   `json:"final,omitempty"`
	Decision               string `json:"decision,omitempty"`
	CaseID                 string `json:"case_id,omitempty"`
}

func doJSON(ctx context.Context, cfg HTTPProviderConfig, method, path string, in any, out *providerEnvelope, idempotency string) error {
	body, err := json.Marshal(in)
	if err != nil {
		return fmt.Errorf("marshal provider request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(cfg.BaseURL, "/")+"/"+strings.TrimLeft(path, "/"), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build provider request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Idempotency-Key", idempotency)
	if cfg.Token != "" {
		req.Header.Set("Authorization", "Bearer "+cfg.Token)
	}
	resp, err := cfg.Client.Do(req)
	if err != nil {
		return fmt.Errorf("provider transport failure: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("provider response read failure: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("provider returned HTTP %d", resp.StatusCode)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("provider returned malformed JSON: %w", err)
	}
	return nil
}

func intentPayload(in Intent) map[string]any {
	return map[string]any{"intent_id": in.ID, "tenant_id": in.TenantID, "direction": in.Direction, "asset": in.Asset, "fiat": in.Fiat, "amount_minor": in.AmountMinor, "destination": in.Destination, "payload_sha256": PayloadDigest(in.Payload)}
}

// HTTPFiatRail is a provider-neutral bank/PSP/IMTO adapter. Provider-specific
// contracts are represented by the stable envelope and must be contract-tested.
type HTTPFiatRail struct{ cfg HTTPProviderConfig }

func NewHTTPFiatRail(cfg HTTPProviderConfig) (*HTTPFiatRail, error) {
	if err := validateHTTPConfig(cfg); err != nil {
		return nil, err
	}
	return &HTTPFiatRail{cfg: cfg}, nil
}
func (p *HTTPFiatRail) call(ctx context.Context, path string, in Intent) (ProviderResult, error) {
	var out providerEnvelope
	err := doJSON(ctx, p.cfg, "POST", path, intentPayload(in), &out, in.IdempotencyKey)
	if err != nil {
		return ProviderResult{State: Unknown, Reason: "fiat provider outcome unknown"}, err
	}
	if out.State == Unknown {
		return ProviderResult{State: Unknown}, ErrUnknown
	}
	return ProviderResult{Reference: out.Reference, State: out.State, Reason: out.Reason, RetryableWithoutEffect: out.RetryableWithoutEffect}, nil
}
func (p *HTTPFiatRail) Quote(ctx context.Context, in Intent) (ProviderResult, error) {
	return p.call(ctx, "quote", in)
}
func (p *HTTPFiatRail) Collect(ctx context.Context, in Intent) (ProviderResult, error) {
	return p.call(ctx, "collect", in)
}
func (p *HTTPFiatRail) Payout(ctx context.Context, in Intent) (ProviderResult, error) {
	return p.call(ctx, "payout", in)
}
func (p *HTTPFiatRail) Query(ctx context.Context, in Intent) (ProviderResult, error) {
	return p.call(ctx, "status", in)
}
func (p *HTTPFiatRail) Refund(ctx context.Context, in Intent) (ProviderResult, error) {
	return p.call(ctx, "refund", in)
}

// HTTPCustodyProvider is an HSM/custody-vendor boundary. It never carries a
// private key and refuses unknown outcomes.
type HTTPCustodyProvider struct{ cfg HTTPProviderConfig }

func NewHTTPCustodyProvider(cfg HTTPProviderConfig) (*HTTPCustodyProvider, error) {
	if err := validateHTTPConfig(cfg); err != nil {
		return nil, err
	}
	return &HTTPCustodyProvider{cfg: cfg}, nil
}
func (p *HTTPCustodyProvider) SubmitTransfer(ctx context.Context, in Intent) (ProviderResult, error) {
	return p.call(ctx, "transfers", in)
}
func (p *HTTPCustodyProvider) QueryTransfer(ctx context.Context, in Intent) (ProviderResult, error) {
	return p.call(ctx, "transfers/status", in)
}
func (p *HTTPCustodyProvider) Balance(ctx context.Context, asset, wallet string) (int64, error) {
	var out providerEnvelope
	err := doJSON(ctx, p.cfg, "POST", "balance", map[string]string{"asset": asset, "wallet": wallet}, &out, "balance-"+asset+"-"+wallet)
	if err != nil {
		return 0, err
	}
	if out.State == Unknown {
		return 0, ErrUnknown
	}
	return parseAmount(out.Reason)
}
func (p *HTTPCustodyProvider) call(ctx context.Context, path string, in Intent) (ProviderResult, error) {
	var out providerEnvelope
	err := doJSON(ctx, p.cfg, "POST", path, intentPayload(in), &out, in.IdempotencyKey)
	if err != nil {
		return ProviderResult{State: Unknown, Reason: "custody outcome unknown"}, err
	}
	if out.State == Unknown {
		return ProviderResult{State: Unknown}, ErrUnknown
	}
	return ProviderResult{Reference: out.Reference, BlockchainTx: out.BlockchainTx, State: out.State, Reason: out.Reason, RetryableWithoutEffect: out.RetryableWithoutEffect}, nil
}

// HTTPFinalityProvider is read-only and must be backed by a chain-specific
// observer in production.
type HTTPFinalityProvider struct{ cfg HTTPProviderConfig }

func NewHTTPFinalityProvider(cfg HTTPProviderConfig) (*HTTPFinalityProvider, error) {
	if err := validateHTTPConfig(cfg); err != nil {
		return nil, err
	}
	return &HTTPFinalityProvider{cfg: cfg}, nil
}
func (p *HTTPFinalityProvider) Observe(ctx context.Context, tx, asset string) (ProviderResult, error) {
	var out providerEnvelope
	err := doJSON(ctx, p.cfg, "POST", "observe", map[string]string{"tx": tx, "asset": asset}, &out, "observe-"+tx)
	if err != nil {
		return ProviderResult{State: Unknown, Reason: "finality outcome unknown"}, err
	}
	if out.State == Unknown {
		return ProviderResult{State: Unknown}, ErrUnknown
	}
	return ProviderResult{Reference: out.Reference, BlockchainTx: out.BlockchainTx, State: out.State, Reason: out.Reason}, nil
}
func (p *HTTPFinalityProvider) IsFinal(ctx context.Context, tx, asset string) (bool, error) {
	out, err := p.Observe(ctx, tx, asset)
	if err != nil {
		return false, err
	}
	if out.State != Settled {
		return false, nil
	}
	return strings.EqualFold(out.Reason, "final") || strings.EqualFold(out.Reason, "confirmed_final"), nil
}

// HTTPScreeningProvider performs a pre-execution compliance decision.
type HTTPScreeningProvider struct{ cfg HTTPProviderConfig }

func NewHTTPScreeningProvider(cfg HTTPProviderConfig) (*HTTPScreeningProvider, error) {
	if err := validateHTTPConfig(cfg); err != nil {
		return nil, err
	}
	return &HTTPScreeningProvider{cfg: cfg}, nil
}
func (p *HTTPScreeningProvider) Screen(ctx context.Context, in Intent) (ScreenResult, error) {
	var out providerEnvelope
	err := doJSON(ctx, p.cfg, "POST", "screen", intentPayload(in), &out, in.IdempotencyKey)
	if err != nil {
		return ScreenResult{}, err
	}
	if out.Decision == "" {
		return ScreenResult{}, errors.New("screening decision missing")
	}
	return ScreenResult{Decision: out.Decision, CaseID: out.CaseID, Reason: out.Reason}, nil
}

// VerifyWebhookHMAC is retained for legacy low-level callers. Provider webhook
// handlers must use VerifyWebhookHMACWithTimestamp to prevent replay attacks.
func VerifyWebhookHMAC(body []byte, signature, secret string) bool {
	if secret == "" || signature == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	expected := hex.EncodeToString(mac.Sum(nil))
	provided := strings.TrimSpace(signature)
	if len(provided) >= len("sha256=") && strings.EqualFold(provided[:len("sha256=")], "sha256=") {
		provided = provided[len("sha256="):]
	}
	decoded, err := hex.DecodeString(provided)
	if err != nil || len(decoded) != sha256.Size {
		return false
	}
	return hmac.Equal(decoded, mac.Sum(nil)) && len(expected) == sha256.Size*2
}

// VerifyWebhookHMACWithTimestamp verifies the standard timestamped webhook
// envelope: "t=<unix-seconds>,v1=<lowercase-hex-hmac>". The MAC covers
// timestamp + "." + raw body. It rejects missing fields, malformed values,
// stale/future timestamps, and malformed digests before any side effect.
func VerifyWebhookHMACWithTimestamp(body []byte, signature, secret string, now time.Time, maxAge, maxFutureSkew time.Duration) bool {
	if secret == "" || signature == "" || maxAge <= 0 || maxFutureSkew < 0 {
		return false
	}
	var timestamp string
	var providedHex string
	for _, part := range strings.Split(signature, ",") {
		keyValue := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(keyValue) != 2 {
			return false
		}
		switch strings.ToLower(keyValue[0]) {
		case "t":
			if timestamp != "" {
				return false
			}
			timestamp = keyValue[1]
		case "v1":
			if providedHex != "" {
				return false
			}
			providedHex = keyValue[1]
		default:
			return false
		}
	}
	unix, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || timestamp == "" || providedHex == "" {
		return false
	}
	at := time.Unix(unix, 0)
	age := now.Sub(at)
	if age < -maxFutureSkew || age > maxAge {
		return false
	}
	provided, err := hex.DecodeString(providedHex)
	if err != nil || len(provided) != sha256.Size {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp + "."))
	_, _ = mac.Write(body)
	return hmac.Equal(provided, mac.Sum(nil))
}
func parseAmount(s string) (int64, error) {
	var n int64
	if _, err := fmt.Sscan(s, &n); err != nil {
		return 0, errors.New("provider balance must be integer minor units")
	}
	return n, nil
}

var _ = time.Second
