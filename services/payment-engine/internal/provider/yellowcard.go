package provider

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
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// YellowCardRFQ is an offer request only. It cannot accept a quote, move an
// asset, initiate a payout, create a wallet, or establish settlement.
type YellowCardRFQ struct {
	IdempotencyKey      string
	Corridor            string
	SourceStablecoin    string
	DestinationCurrency string
	Amount              string
}

// YellowCardRFQResult records the provider's reviewable RFQ reference. It is
// not a confirmed conversion, transfer, balance, or settlement fact.
type YellowCardRFQResult struct {
	Reference      string
	IdempotencyKey string
	Status         string
}

type DisabledYellowCardClient struct{}

func (DisabledYellowCardClient) CreateRFQ(context.Context, YellowCardRFQ) (YellowCardRFQResult, error) {
	return YellowCardRFQResult{}, errors.New("Yellow Card provider is not configured and RFQ creation is disabled")
}

// YellowCardSigner keeps both API-key lookup and secret-key HMAC generation in
// a deployment secret boundary. The HTTP adapter never accepts a key from an
// API request, counterparty record, PostgreSQL row, or browser form.
type YellowCardSigner interface {
	SignYellowCard(ctx context.Context, message []byte) (apiKey string, signature string, err error)
}

// HMACYellowCardSigner is constructed only from resolved deployment secrets.
// It is useful for a trusted runtime composition layer; callers must never
// persist or serialize this value.
type HMACYellowCardSigner struct {
	apiKey string
	secret []byte
}

func NewHMACYellowCardSigner(apiKey string, secret []byte) (*HMACYellowCardSigner, error) {
	if strings.TrimSpace(apiKey) == "" || len(secret) < 16 {
		return nil, errors.New("Yellow Card API key and a non-empty secret are required")
	}
	return &HMACYellowCardSigner{apiKey: apiKey, secret: append([]byte(nil), secret...)}, nil
}

func (s *HMACYellowCardSigner) SignYellowCard(_ context.Context, message []byte) (string, string, error) {
	if s == nil || strings.TrimSpace(s.apiKey) == "" || len(s.secret) < 16 {
		return "", "", errors.New("Yellow Card signing material is unavailable")
	}
	mac := hmac.New(sha256.New, s.secret)
	_, _ = mac.Write(message)
	return s.apiKey, base64.StdEncoding.EncodeToString(mac.Sum(nil)), nil
}

type YellowCardConfig struct {
	BaseURL               string
	Signer                YellowCardSigner
	HTTPClient            *http.Client
	Now                   func() time.Time
	AllowInsecureLoopback bool
}

type YellowCardClient struct {
	baseURL *url.URL
	signer  YellowCardSigner
	http    *http.Client
	now     func() time.Time
}

func NewYellowCardClient(config YellowCardConfig) (*YellowCardClient, error) {
	baseURL, err := url.Parse(config.BaseURL)
	if err != nil || baseURL.Scheme == "" || baseURL.Hostname() == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("Yellow Card base URL must be an absolute credential-free URL")
	}
	if baseURL.Scheme != "https" && !(baseURL.Scheme == "http" && config.AllowInsecureLoopback && isLoopbackHost(baseURL.Hostname())) {
		return nil, errors.New("Yellow Card transport must use HTTPS unless explicit loopback development transport is enabled")
	}
	if config.Signer == nil {
		return nil, errors.New("Yellow Card signer is required")
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	now := config.Now
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &YellowCardClient{baseURL: baseURL, signer: config.Signer, http: client, now: now}, nil
}

func validateYellowCardRFQ(rfq YellowCardRFQ) error {
	if !uuidPattern.MatchString(rfq.IdempotencyKey) {
		return errors.New("Yellow Card idempotency key must be a UUID")
	}
	if rfq.SourceStablecoin != "USDC" && rfq.SourceStablecoin != "USDT" {
		return errors.New("Yellow Card source asset must be USDC or USDT")
	}
	expected, ok := corridorCurrency[rfq.Corridor]
	if !ok || rfq.DestinationCurrency != expected {
		return errors.New("Yellow Card corridor and destination currency are not a supported pair")
	}
	amount, ok := new(big.Rat).SetString(rfq.Amount)
	if !ok || amount.Sign() <= 0 {
		return errors.New("Yellow Card RFQ amount must be a positive decimal")
	}
	return nil
}

type yellowCardRFQRequest struct {
	SourceCurrency          string `json:"sourceCurrency"`
	SourceCurrencyType      string `json:"sourceCurrencyType"`
	DestinationCurrency     string `json:"destinationCurrency"`
	DestinationCurrencyType string `json:"destinationCurrencyType"`
	Amount                  string `json:"amount"`
	IdempotencyKey          string `json:"idempotencyKey"`
}

type yellowCardRFQResponse struct {
	ID                  string      `json:"id"`
	IdempotencyKey      string      `json:"idempotencyKey"`
	SourceCurrency      string      `json:"sourceCurrency"`
	SourceCurrencyType  string      `json:"sourceCurrencyType"`
	DestinationCurrency string      `json:"destinationCurrency"`
	DestinationType     string      `json:"destinationCurrencyType"`
	Amount              json.Number `json:"amount"`
	Status              string      `json:"status"`
}

func (c *YellowCardClient) CreateRFQ(ctx context.Context, rfq YellowCardRFQ) (YellowCardRFQResult, error) {
	if err := validateYellowCardRFQ(rfq); err != nil {
		return YellowCardRFQResult{}, err
	}
	payload := yellowCardRFQRequest{
		SourceCurrency:          rfq.SourceStablecoin,
		SourceCurrencyType:      "crypto",
		DestinationCurrency:     rfq.DestinationCurrency,
		DestinationCurrencyType: "fiat",
		Amount:                  rfq.Amount,
		IdempotencyKey:          rfq.IdempotencyKey,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return YellowCardRFQResult{}, fmt.Errorf("encode Yellow Card RFQ: %w", err)
	}
	endpoint := *c.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/rfq"
	endpoint.RawPath = ""
	timestamp := c.now().UTC().Format(time.RFC3339Nano)
	digest := sha256.Sum256(body)
	message := []byte(timestamp + endpoint.EscapedPath() + http.MethodPost + base64.StdEncoding.EncodeToString(digest[:]))
	apiKey, signature, err := c.signer.SignYellowCard(ctx, message)
	if err != nil || strings.TrimSpace(apiKey) == "" || strings.TrimSpace(signature) == "" {
		return YellowCardRFQResult{}, errors.New("Yellow Card request signing is unavailable")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return YellowCardRFQResult{}, fmt.Errorf("create Yellow Card RFQ request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-YC-Timestamp", timestamp)
	request.Header.Set("Authorization", "YcHmacV1 "+apiKey+":"+signature)

	response, err := c.http.Do(request)
	if err != nil {
		return YellowCardRFQResult{}, errors.New("Yellow Card endpoint is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusCreated {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return YellowCardRFQResult{}, fmt.Errorf("Yellow Card RFQ was not created: HTTP %d", response.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 256*1024))
	decoder.UseNumber()
	var decoded yellowCardRFQResponse
	if err := decoder.Decode(&decoded); err != nil {
		return YellowCardRFQResult{}, errors.New("Yellow Card RFQ response was not valid JSON")
	}
	if strings.TrimSpace(decoded.ID) == "" || decoded.IdempotencyKey != rfq.IdempotencyKey || decoded.SourceCurrency != rfq.SourceStablecoin || decoded.SourceCurrencyType != "crypto" || decoded.DestinationCurrency != rfq.DestinationCurrency || decoded.DestinationType != "fiat" || decoded.Amount.String() != rfq.Amount || strings.TrimSpace(decoded.Status) == "" {
		return YellowCardRFQResult{}, errors.New("Yellow Card RFQ response does not match the submitted offer request")
	}
	return YellowCardRFQResult{Reference: decoded.ID, IdempotencyKey: decoded.IdempotencyKey, Status: decoded.Status}, nil
}

// YellowCardWebhook contains only the minimal non-sensitive correlation and
// lifecycle metadata that a caller may subsequently bind to canonical evidence.
type YellowCardWebhook struct {
	ID         string `json:"id"`
	SequenceID string `json:"sequenceId"`
	Status     string `json:"status"`
	Event      string `json:"event"`
	ExecutedAt string `json:"executedAt"`
}

func VerifyYellowCardWebhook(secret []byte, signature string, body []byte) (YellowCardWebhook, error) {
	if len(secret) < 16 || strings.TrimSpace(signature) == "" || len(body) == 0 {
		return YellowCardWebhook{}, errors.New("Yellow Card webhook verification material is unavailable")
	}
	provided, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		return YellowCardWebhook{}, errors.New("Yellow Card webhook signature is not base64")
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(body)
	if !hmac.Equal(provided, mac.Sum(nil)) {
		return YellowCardWebhook{}, errors.New("Yellow Card webhook signature is invalid")
	}
	var event YellowCardWebhook
	if err := json.Unmarshal(body, &event); err != nil {
		return YellowCardWebhook{}, errors.New("Yellow Card webhook payload is not valid JSON")
	}
	if strings.TrimSpace(event.ID) == "" || strings.TrimSpace(event.SequenceID) == "" || strings.TrimSpace(event.Status) == "" || strings.TrimSpace(event.Event) == "" || strings.TrimSpace(event.ExecutedAt) == "" {
		return YellowCardWebhook{}, errors.New("Yellow Card webhook is missing required lifecycle metadata")
	}
	if _, err := time.Parse(time.RFC3339Nano, event.ExecutedAt); err != nil {
		return YellowCardWebhook{}, errors.New("Yellow Card webhook execution time is invalid")
	}
	return event, nil
}
