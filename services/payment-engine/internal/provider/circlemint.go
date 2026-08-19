package provider

import (
	"context"
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

// CircleUSDCBalance is a provider-reported observed balance item. It is not a
// custody, funding, liquidity-availability, conversion, transfer, or
// settlement assertion by UmojaFlowOS.
type CircleUSDCBalance struct {
	Amount string
}

// CircleBusinessBalances separates the provider's available and unsettled USDC
// observations. The caller must still reconcile them and receive all required
// counterparty, custody, funding, and policy approvals before any use.
type CircleBusinessBalances struct {
	Available []CircleUSDCBalance
	Unsettled []CircleUSDCBalance
}

type DisabledCircleMintClient struct{}

func (DisabledCircleMintClient) ListUSDCBalances(context.Context, string) (CircleBusinessBalances, error) {
	return CircleBusinessBalances{}, errors.New("Circle Mint is not configured and USDC balance observation is disabled")
}

type CircleMintConfig struct {
	BaseURL               string
	APIKey                string
	HTTPClient            *http.Client
	AllowInsecureLoopback bool
}

type CircleMintClient struct {
	baseURL *url.URL
	apiKey  string
	http    *http.Client
}

func NewCircleMintClient(config CircleMintConfig) (*CircleMintClient, error) {
	baseURL, err := url.Parse(config.BaseURL)
	if err != nil || baseURL.Scheme == "" || baseURL.Hostname() == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return nil, errors.New("Circle Mint base URL must be an absolute credential-free URL")
	}
	if baseURL.Scheme != "https" && !(baseURL.Scheme == "http" && config.AllowInsecureLoopback && isLoopbackHost(baseURL.Hostname())) {
		return nil, errors.New("Circle Mint transport must use HTTPS unless explicit loopback development transport is enabled")
	}
	if strings.TrimSpace(config.APIKey) == "" {
		return nil, errors.New("Circle Mint API key is required from trusted runtime composition")
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &CircleMintClient{baseURL: baseURL, apiKey: config.APIKey, http: client}, nil
}

type circleMintBalanceResponse struct {
	Data struct {
		Available []struct {
			Amount   string `json:"amount"`
			Currency string `json:"currency"`
		} `json:"available"`
		Unsettled []struct {
			Amount   string `json:"amount"`
			Currency string `json:"currency"`
		} `json:"unsettled"`
	} `json:"data"`
}

func normalizeUSDCBalances(items []struct {
	Amount   string `json:"amount"`
	Currency string `json:"currency"`
}) ([]CircleUSDCBalance, error) {
	balances := make([]CircleUSDCBalance, 0, len(items))
	for _, item := range items {
		if item.Currency != "USDC" {
			continue
		}
		amount, ok := new(big.Rat).SetString(item.Amount)
		if !ok || amount.Sign() < 0 {
			return nil, errors.New("Circle Mint returned an invalid USDC balance amount")
		}
		balances = append(balances, CircleUSDCBalance{Amount: item.Amount})
	}
	return balances, nil
}

// ListUSDCBalances calls Circle Mint's documented GET
// /v1/businessAccount/balances endpoint only. walletID is optional and selects
// the configured Circle wallet; no wallet is created, linked, funded, or moved.
func (c *CircleMintClient) ListUSDCBalances(ctx context.Context, walletID string) (CircleBusinessBalances, error) {
	if c == nil || c.baseURL == nil || strings.TrimSpace(c.apiKey) == "" {
		return CircleBusinessBalances{}, errors.New("Circle Mint client is not configured")
	}
	endpoint := *c.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/v1/businessAccount/balances"
	query := endpoint.Query()
	if strings.TrimSpace(walletID) != "" {
		query.Set("walletId", walletID)
	}
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return CircleBusinessBalances{}, fmt.Errorf("create Circle Mint balance request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+c.apiKey)
	response, err := c.http.Do(request)
	if err != nil {
		return CircleBusinessBalances{}, errors.New("Circle Mint endpoint is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return CircleBusinessBalances{}, fmt.Errorf("Circle Mint balance request failed: HTTP %d", response.StatusCode)
	}
	var decoded circleMintBalanceResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 256*1024)).Decode(&decoded); err != nil {
		return CircleBusinessBalances{}, errors.New("Circle Mint balance response was not valid JSON")
	}
	available, err := normalizeUSDCBalances(decoded.Data.Available)
	if err != nil {
		return CircleBusinessBalances{}, err
	}
	unsettled, err := normalizeUSDCBalances(decoded.Data.Unsettled)
	if err != nil {
		return CircleBusinessBalances{}, err
	}
	return CircleBusinessBalances{Available: available, Unsettled: unsettled}, nil
}
