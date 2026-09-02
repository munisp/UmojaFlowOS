package reconciliation

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type opaRequest struct {
	Input IntentPolicyInput `json:"input"`
}
type opaResponse struct {
	Result *struct {
		Allow  bool   `json:"allow"`
		Reason string `json:"reason"`
	} `json:"result"`
}

// HTTPIntentPolicy evaluates the native Idem intent against an OPA sidecar.
// Any transport, decode, or missing-result error is a hard deny.
type HTTPIntentPolicy struct {
	Endpoint string
	Client   *http.Client
}

func (p HTTPIntentPolicy) Evaluate(ctx context.Context, input IntentPolicyInput) (IntentPolicyDecision, error) {
	if strings.TrimSpace(p.Endpoint) == "" {
		return IntentPolicyDecision{}, errors.New("OPA endpoint is required")
	}
	body, err := json.Marshal(opaRequest{Input: input})
	if err != nil {
		return IntentPolicyDecision{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.Endpoint, bytes.NewReader(body))
	if err != nil {
		return IntentPolicyDecision{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	client := p.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		return IntentPolicyDecision{}, fmt.Errorf("OPA request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return IntentPolicyDecision{}, fmt.Errorf("OPA returned HTTP %d", resp.StatusCode)
	}
	var decoded opaResponse
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return IntentPolicyDecision{}, fmt.Errorf("decode OPA response: %w", err)
	}
	if decoded.Result == nil {
		return IntentPolicyDecision{}, errors.New("OPA result is absent")
	}
	return IntentPolicyDecision{Allow: decoded.Result.Allow, Reason: decoded.Result.Reason}, nil
}
