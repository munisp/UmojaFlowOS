package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestValidationAllowsPolicyDecisionButNeverStartsProviderExecution(t *testing.T) {
	handler := newHandler(func() time.Time { return time.Date(2026, 8, 17, 0, 0, 0, 0, time.UTC) })
	request := httptest.NewRequest(http.MethodPost, "/v1/orders/validate", bytes.NewBufferString(`{"id":"order-1","idempotency_key":"key-123","corridor":"NIGERIA_NGN","source_currency":"NGN","source_amount":"100","target_currency":"USD","target_amount":"1","policy_outcome":"ALLOW","policy_version":"2026.08"}`))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
	if !bytes.Contains(response.Body.Bytes(), []byte(`"status":"APPROVED"`)) || !bytes.Contains(response.Body.Bytes(), []byte(`"provider_execution":"disabled_without_verified_provider"`)) {
		t.Fatalf("unexpected response: %s", response.Body.String())
	}
}
