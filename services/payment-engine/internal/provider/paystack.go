package provider

import (
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"time"
)

// PaystackTransactionVerification is a provider-reported transaction fact. It
// is not an UmojaFlowOS payment execution, settlement, licensing, or CBN
// approval assertion. Transfer initiation deliberately has no implementation.
type PaystackTransactionVerification struct {
	Reference string
	Status    string
	Amount    json.Number
	Currency  string
}

type DisabledPaystackClient struct{}

func (DisabledPaystackClient) VerifyTransaction(context.Context, string) (PaystackTransactionVerification, error) {
	return PaystackTransactionVerification{}, errors.New("Paystack provider is not configured and transaction verification is disabled")
}

type PaystackConfig struct {
	BaseURL               string
	SecretKey             string
	HTTPClient            *http.Client
	AllowInsecureLoopback bool
}

type PaystackClient struct {
	baseURL   *url.URL
	secretKey string
	http      *http.Client
}

func NewPaystackClient(config PaystackConfig) (*PaystackClient, error) {
	baseURL, err := url.Parse(config.BaseURL)
	if err != nil || baseURL.Scheme == "" || baseURL.Hostname() == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("Paystack base URL must be an absolute credential-free URL")
	}
	if baseURL.Scheme != "https" && !(baseURL.Scheme == "http" && config.AllowInsecureLoopback && isLoopbackHost(baseURL.Hostname())) {
		return nil, errors.New("Paystack transport must use HTTPS unless explicit loopback development transport is enabled")
	}
	if strings.TrimSpace(config.SecretKey) == "" {
		return nil, errors.New("Paystack secret key is required from trusted runtime composition")
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &PaystackClient{baseURL: baseURL, secretKey: config.SecretKey, http: client}, nil
}

var providerReferencePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,128}$`)

type paystackVerificationResponse struct {
	Status bool `json:"status"`
	Data   struct {
		Reference string      `json:"reference"`
		Status    string      `json:"status"`
		Amount    json.Number `json:"amount"`
		Currency  string      `json:"currency"`
	} `json:"data"`
}

// VerifyTransaction performs only Paystack's documented transaction-verification
// read. A 2xx provider response is still not accepted as settlement evidence.
func (c *PaystackClient) VerifyTransaction(ctx context.Context, reference string) (PaystackTransactionVerification, error) {
	if c == nil || c.baseURL == nil || strings.TrimSpace(c.secretKey) == "" {
		return PaystackTransactionVerification{}, errors.New("Paystack client is not configured")
	}
	if !providerReferencePattern.MatchString(reference) {
		return PaystackTransactionVerification{}, errors.New("Paystack reference has an invalid format")
	}
	endpoint := *c.baseURL
	endpoint.Path = path.Join(strings.TrimSuffix(endpoint.Path, "/"), "transaction", "verify", reference)
	endpoint.RawPath = ""
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return PaystackTransactionVerification{}, fmt.Errorf("create Paystack verification request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+c.secretKey)
	response, err := c.http.Do(request)
	if err != nil {
		return PaystackTransactionVerification{}, errors.New("Paystack endpoint is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return PaystackTransactionVerification{}, fmt.Errorf("Paystack transaction verification failed: HTTP %d", response.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 256*1024))
	decoder.UseNumber()
	var decoded paystackVerificationResponse
	if err := decoder.Decode(&decoded); err != nil {
		return PaystackTransactionVerification{}, errors.New("Paystack verification response was not valid JSON")
	}
	amount, validAmount := new(big.Int).SetString(decoded.Data.Amount.String(), 10)
	if !decoded.Status || decoded.Data.Reference != reference || strings.TrimSpace(decoded.Data.Status) == "" || !validAmount || amount.Sign() <= 0 || (decoded.Data.Currency != "NGN" && decoded.Data.Currency != "KES" && decoded.Data.Currency != "ZAR") {
		return PaystackTransactionVerification{}, errors.New("Paystack verification response does not match a permitted UmojaFlowOS corridor record")
	}
	return PaystackTransactionVerification{Reference: decoded.Data.Reference, Status: decoded.Data.Status, Amount: decoded.Data.Amount, Currency: decoded.Data.Currency}, nil
}

// PaystackWebhook is limited to correlation/lifecycle data. It does not confirm
// settlement, release a ledger posting, or alter a payment state.
type PaystackWebhook struct {
	Event     string
	Reference string
	Status    string
}

func VerifyPaystackWebhook(secretKey, signature string, body []byte) (PaystackWebhook, error) {
	if strings.TrimSpace(secretKey) == "" || strings.TrimSpace(signature) == "" || len(body) == 0 {
		return PaystackWebhook{}, errors.New("Paystack webhook verification material is unavailable")
	}
	provided, err := hex.DecodeString(signature)
	if err != nil {
		return PaystackWebhook{}, errors.New("Paystack webhook signature is not hexadecimal")
	}
	mac := hmac.New(sha512.New, []byte(secretKey))
	_, _ = mac.Write(body)
	if !hmac.Equal(provided, mac.Sum(nil)) {
		return PaystackWebhook{}, errors.New("Paystack webhook signature is invalid")
	}
	var decoded struct {
		Event string `json:"event"`
		Data  struct {
			Reference string `json:"reference"`
			Status    string `json:"status"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return PaystackWebhook{}, errors.New("Paystack webhook payload was not valid JSON")
	}
	if strings.TrimSpace(decoded.Event) == "" || !providerReferencePattern.MatchString(decoded.Data.Reference) || strings.TrimSpace(decoded.Data.Status) == "" {
		return PaystackWebhook{}, errors.New("Paystack webhook lacks required non-sensitive lifecycle metadata")
	}
	return PaystackWebhook{Event: decoded.Event, Reference: decoded.Data.Reference, Status: decoded.Data.Status}, nil
}
