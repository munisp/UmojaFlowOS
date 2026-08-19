package provider

import (
	"context"
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

// DarajaAccessToken proves only that Safaricom returned an OAuth credential for
// the configured Kenya (KES) account. It cannot initiate, confirm, reverse, or
// settle an M-PESA payment, and does not establish a Daraja production approval.
type DarajaAccessToken struct {
	AccessToken string
	ExpiresIn   int
}

type DisabledDarajaClient struct{}

func (DisabledDarajaClient) FetchAccessToken(context.Context) (DarajaAccessToken, error) {
	return DarajaAccessToken{}, errors.New("Safaricom Daraja provider is not configured and OAuth validation is disabled")
}

type DarajaConfig struct {
	BaseURL               string
	ConsumerKey           string
	ConsumerSecret        string
	HTTPClient            *http.Client
	AllowInsecureLoopback bool
}

type DarajaClient struct {
	baseURL        *url.URL
	consumerKey    string
	consumerSecret string
	http           *http.Client
}

func NewDarajaClient(config DarajaConfig) (*DarajaClient, error) {
	baseURL, err := url.Parse(config.BaseURL)
	if err != nil || baseURL.Scheme == "" || baseURL.Hostname() == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("Safaricom Daraja base URL must be an absolute credential-free URL")
	}
	if baseURL.Scheme != "https" && !(baseURL.Scheme == "http" && config.AllowInsecureLoopback && isLoopbackHost(baseURL.Hostname())) {
		return nil, errors.New("Safaricom Daraja transport must use HTTPS unless explicit loopback development transport is enabled")
	}
	if strings.TrimSpace(config.ConsumerKey) == "" || strings.TrimSpace(config.ConsumerSecret) == "" {
		return nil, errors.New("Safaricom Daraja consumer credentials are required from trusted runtime composition")
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &DarajaClient{baseURL: baseURL, consumerKey: config.ConsumerKey, consumerSecret: config.ConsumerSecret, http: client}, nil
}

// FetchAccessToken calls only Daraja's documented OAuth grant endpoint. It is
// intentionally the whole adapter surface until an approved account, product,
// callback registration, and separate execution-authority gate are present.
func (c *DarajaClient) FetchAccessToken(ctx context.Context) (DarajaAccessToken, error) {
	if c == nil || c.baseURL == nil || strings.TrimSpace(c.consumerKey) == "" || strings.TrimSpace(c.consumerSecret) == "" {
		return DarajaAccessToken{}, errors.New("Safaricom Daraja client is not configured")
	}
	endpoint := *c.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/oauth/v1/generate"
	query := endpoint.Query()
	query.Set("grant_type", "client_credentials")
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return DarajaAccessToken{}, fmt.Errorf("create Safaricom Daraja OAuth request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(c.consumerKey+":"+c.consumerSecret)))
	response, err := c.http.Do(request)
	if err != nil {
		return DarajaAccessToken{}, errors.New("Safaricom Daraja endpoint is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return DarajaAccessToken{}, fmt.Errorf("Safaricom Daraja OAuth request failed: HTTP %d", response.StatusCode)
	}
	var decoded struct {
		AccessToken string          `json:"access_token"`
		ExpiresIn   json.RawMessage `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&decoded); err != nil {
		return DarajaAccessToken{}, errors.New("Safaricom Daraja OAuth response was not valid JSON")
	}
	var lifetimeText string
	if err := json.Unmarshal(decoded.ExpiresIn, &lifetimeText); err != nil {
		lifetimeText = string(decoded.ExpiresIn)
	}
	expiresIn, err := strconv.Atoi(strings.TrimSpace(lifetimeText))
	if err != nil || strings.TrimSpace(decoded.AccessToken) == "" || expiresIn <= 0 {
		return DarajaAccessToken{}, errors.New("Safaricom Daraja OAuth response lacks a valid access token lifetime")
	}
	return DarajaAccessToken{AccessToken: decoded.AccessToken, ExpiresIn: expiresIn}, nil
}
