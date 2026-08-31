package provider

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/multirail"
)

// NigerianBankTransfer is the canonical provider-neutral payload required by a
// Nigerian bank or PSP execution rail. The actual counterparty-specific adapter
// may transform these fields internally, but must preserve SequenceID as the
// idempotency binding.
type NigerianBankTransfer struct {
	SequenceID    string `json:"sequenceId"`
	AmountMinor   int64  `json:"amountMinor"`
	Currency      string `json:"currency"`
	BankCode      string `json:"bankCode"`
	AccountNumber string `json:"accountNumber"`
	AccountName   string `json:"accountName"`
	Narration     string `json:"narration"`
}

type NigerianBankRailConfig struct {
	BaseURL               string
	BearerToken           string
	HTTPClient            *http.Client
	AllowInsecureLoopback bool
}

type NigerianBankRailClient struct {
	baseURL *url.URL
	token   string
	http    *http.Client
}

var (
	nigerianAccountPattern  = regexp.MustCompile(`^[0-9]{10}$`)
	nigerianBankCodePattern = regexp.MustCompile(`^[0-9]{3,6}$`)
)

func NewNigerianBankRailClient(config NigerianBankRailConfig) (*NigerianBankRailClient, error) {
	baseURL, err := url.Parse(config.BaseURL)
	if err != nil || baseURL.Scheme == "" || baseURL.Hostname() == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("Nigerian bank rail base URL must be an absolute credential-free URL")
	}
	if baseURL.Scheme != "https" && !(config.AllowInsecureLoopback && baseURL.Scheme == "http" && isLoopbackHost(baseURL.Hostname())) {
		return nil, errors.New("Nigerian bank rail transport must use HTTPS unless explicit loopback development transport is enabled")
	}
	if strings.TrimSpace(config.BearerToken) == "" {
		return nil, errors.New("Nigerian bank rail bearer token is required from trusted runtime composition")
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &NigerianBankRailClient{baseURL: baseURL, token: config.BearerToken, http: client}, nil
}

func (c *NigerianBankRailClient) Name() string { return "nigerian_bank_psp" }

func decodeNigerianTransfer(intent multirail.Intent) (NigerianBankTransfer, error) {
	if intent.ID == "" || intent.IdempotencyKey == "" || len(intent.Payload) == 0 {
		return NigerianBankTransfer{}, errors.New("Nigerian rail requires a bound intent and canonical payload")
	}
	var transfer NigerianBankTransfer
	if err := json.Unmarshal(intent.Payload, &transfer); err != nil {
		return NigerianBankTransfer{}, errors.New("Nigerian rail payload is not valid canonical JSON")
	}
	if transfer.SequenceID != intent.IdempotencyKey || transfer.SequenceID == "" {
		return NigerianBankTransfer{}, errors.New("Nigerian rail sequence ID does not match the intent idempotency key")
	}
	if transfer.AmountMinor <= 0 || transfer.AmountMinor > math.MaxInt64 || strings.ToUpper(transfer.Currency) != "NGN" || !nigerianAccountPattern.MatchString(transfer.AccountNumber) || !nigerianBankCodePattern.MatchString(transfer.BankCode) || strings.TrimSpace(transfer.AccountName) == "" {
		return NigerianBankTransfer{}, errors.New("Nigerian rail payload failed account, NGN, amount, or beneficiary validation")
	}
	transfer.Currency = "NGN"
	return transfer, nil
}

type nigerianRailResponse struct {
	ID         string `json:"id"`
	Reference  string `json:"reference"`
	SequenceID string `json:"sequenceId"`
	Status     string `json:"status"`
}

func (c *NigerianBankRailClient) Submit(ctx context.Context, intent multirail.Intent) (multirail.Submission, error) {
	if c == nil || c.baseURL == nil || strings.TrimSpace(c.token) == "" || c.http == nil {
		return multirail.Submission{}, errors.New("Nigerian rail client is not configured")
	}
	transfer, err := decodeNigerianTransfer(intent)
	if err != nil {
		return multirail.Submission{}, err
	}
	body, err := json.Marshal(transfer)
	if err != nil {
		return multirail.Submission{}, errors.New("encode Nigerian rail transfer")
	}
	endpoint := *c.baseURL
	endpoint.Path = path.Join(strings.TrimSuffix(endpoint.Path, "/"), "v1", "transfers")
	endpoint.RawPath = ""
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return multirail.Submission{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+c.token)
	request.Header.Set("Idempotency-Key", intent.IdempotencyKey)
	digest := sha256.Sum256(intent.Payload)
	request.Header.Set("X-Umoja-Payload-SHA256", hex.EncodeToString(digest[:]))
	response, err := c.http.Do(request)
	if err != nil {
		return multirail.Submission{}, errors.New("Nigerian rail endpoint is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return multirail.Submission{}, fmt.Errorf("Nigerian rail rejected transfer: HTTP %d", response.StatusCode)
	}
	var decoded nigerianRailResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 256*1024)).Decode(&decoded); err != nil {
		return multirail.Submission{}, errors.New("Nigerian rail response was not valid JSON")
	}
	if decoded.SequenceID != "" && decoded.SequenceID != intent.IdempotencyKey {
		return multirail.Submission{}, errors.New("Nigerian rail response sequence ID mismatch")
	}
	if strings.TrimSpace(decoded.ID) == "" && strings.TrimSpace(decoded.Reference) == "" {
		return multirail.Submission{}, errors.New("Nigerian rail response has no provider reference")
	}
	return normalizeNigerianRailResult(decoded), nil
}

func (c *NigerianBankRailClient) Query(ctx context.Context, intent multirail.Intent) (multirail.Submission, error) {
	if intent.IdempotencyKey == "" || c == nil || c.baseURL == nil || strings.TrimSpace(c.token) == "" {
		return multirail.Submission{}, errors.New("Nigerian rail query is not configured")
	}
	endpoint := *c.baseURL
	endpoint.Path = path.Join(strings.TrimSuffix(endpoint.Path, "/"), "v1", "transfers", url.PathEscape(intent.IdempotencyKey))
	endpoint.RawPath = ""
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return multirail.Submission{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+c.token)
	response, err := c.http.Do(request)
	if err != nil {
		return multirail.Submission{}, errors.New("Nigerian rail lookup endpoint is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return multirail.Submission{}, fmt.Errorf("Nigerian rail lookup failed: HTTP %d", response.StatusCode)
	}
	var decoded nigerianRailResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 256*1024)).Decode(&decoded); err != nil {
		return multirail.Submission{}, errors.New("Nigerian rail lookup response was not valid JSON")
	}
	if decoded.SequenceID != "" && decoded.SequenceID != intent.IdempotencyKey {
		return multirail.Submission{}, errors.New("Nigerian rail lookup sequence ID mismatch")
	}
	return normalizeNigerianRailResult(decoded), nil
}

func normalizeNigerianRailResult(result nigerianRailResponse) multirail.Submission {
	status := strings.ToLower(strings.TrimSpace(result.Status))
	providerRef := result.Reference
	if providerRef == "" {
		providerRef = result.ID
	}
	switch status {
	case "accepted", "created", "queued", "processing", "pending", "in_progress":
		return multirail.Submission{ProviderRef: providerRef, Status: multirail.Pending, Reason: "Nigerian rail accepted the transfer provisionally"}
	case "complete", "completed", "settled", "success", "successful":
		return multirail.Submission{ProviderRef: providerRef, Status: multirail.Settled, Reason: "Nigerian rail independently reported a completed transfer"}
	default:
		return multirail.Submission{ProviderRef: providerRef, Status: multirail.Unknown, Reason: "Nigerian rail status is not safe to classify"}
	}
}
