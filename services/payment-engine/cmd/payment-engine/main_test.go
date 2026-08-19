package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

const fixedClock = "2026-08-17T00:00:00Z"

func handlerAtFixedTime() http.Handler {
	return newHandler(func() time.Time { return time.Date(2026, 8, 17, 0, 0, 0, 0, time.UTC) })
}

func post(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/v1/orders/validate", bytes.NewBufferString(body))
	response := httptest.NewRecorder()
	handlerAtFixedTime().ServeHTTP(response, request)
	return response
}

// envelope mirrors the strict schema the TypeScript control plane applies. Any
// field it does not declare is a contract drift and is rejected there, so the
// decode target is deliberately exact.
type envelope struct {
	EventID       string          `json:"event_id"`
	EventType     string          `json:"event_type"`
	SchemaVersion string          `json:"schema_version"`
	OccurredAt    string          `json:"occurred_at"`
	CorrelationID string          `json:"correlation_id"`
	Payload       json.RawMessage `json:"payload"`
}

func TestValidationEmitsThePublishedVersionedEnvelope(t *testing.T) {
	response := post(t, `{"id":"order-1","idempotency_key":"key-123","corridor":"NIGERIA_NGN","source_currency":"NGN","source_amount":"100","target_currency":"USD","target_amount":"1","policy_outcome":"ALLOW","policy_version":"2026.08","correlation_id":"corr-1"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}

	var decoded envelope
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("response is not a valid envelope: %v", err)
	}
	if decoded.EventType != "umojaflowos.payment.order.validated.v1" {
		t.Fatalf("unexpected event type %q", decoded.EventType)
	}
	if decoded.SchemaVersion != "v1" {
		t.Fatalf("unexpected schema version %q", decoded.SchemaVersion)
	}
	if decoded.CorrelationID != "corr-1" {
		t.Fatalf("supplied correlation id was not preserved: %q", decoded.CorrelationID)
	}
	if decoded.EventID == "" {
		t.Fatal("envelope carries no event id")
	}
	// The control plane requires an RFC 3339 timestamp; a Go zero time or a
	// local-time encoding would fail there rather than here.
	if decoded.OccurredAt != fixedClock {
		t.Fatalf("unexpected occurred_at %q", decoded.OccurredAt)
	}

	var payload struct {
		OrderID           string `json:"order_id"`
		Corridor          string `json:"corridor"`
		Status            string `json:"status"`
		ProviderExecution string `json:"provider_execution"`
	}
	if err := json.Unmarshal(decoded.Payload, &payload); err != nil {
		t.Fatalf("payload is not valid JSON: %v", err)
	}
	if payload.Status != "APPROVED" {
		t.Fatalf("unexpected status %q", payload.Status)
	}
	if payload.Corridor != "NIGERIA_NGN" {
		t.Fatalf("unexpected corridor %q", payload.Corridor)
	}
	// An approved policy decision is not an execution authorisation. The engine
	// states this on every response so no consumer can infer otherwise.
	if payload.ProviderExecution != "disabled_without_verified_provider" {
		t.Fatalf("unexpected provider execution state %q", payload.ProviderExecution)
	}
}

func TestValidationDerivesACorrelationIDWhenTheCallerSuppliesNone(t *testing.T) {
	response := post(t, `{"id":"order-2","idempotency_key":"key-456","corridor":"KENYA_KES","source_currency":"KES","source_amount":"100","target_currency":"USD","target_amount":"1"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", response.Code, response.Body.String())
	}
	var decoded envelope
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("response is not a valid envelope: %v", err)
	}
	// The contract requires a non-empty correlation id, so an absent one must be
	// generated rather than emitted blank.
	if decoded.CorrelationID == "" {
		t.Fatal("correlation id was not derived")
	}
	if decoded.CorrelationID == decoded.EventID {
		t.Fatal("correlation id must not be the event id: they are independently traceable")
	}
}

func TestEachValidationIsIndividuallyTraceable(t *testing.T) {
	body := `{"id":"order-3","idempotency_key":"key-789","corridor":"SOUTH_AFRICA_ZAR","source_currency":"ZAR","source_amount":"100","target_currency":"USD","target_amount":"1","correlation_id":"corr-3"}`
	var first, second envelope
	if err := json.Unmarshal(post(t, body).Body.Bytes(), &first); err != nil {
		t.Fatalf("first response invalid: %v", err)
	}
	if err := json.Unmarshal(post(t, body).Body.Bytes(), &second); err != nil {
		t.Fatalf("second response invalid: %v", err)
	}
	if first.EventID == second.EventID {
		t.Fatal("two validations produced the same event id; replays would be indistinguishable")
	}
}

func TestEnvelopeCarriesNoExecutionOrCredentialKeys(t *testing.T) {
	response := post(t, `{"id":"order-4","idempotency_key":"key-abc","corridor":"NIGERIA_NGN","source_currency":"NGN","source_amount":"100","target_currency":"USD","target_amount":"1"}`)
	// The control plane walks every payload and refuses these keys at any depth.
	for _, forbidden := range []string{`"execute"`, `"settle"`, `"submit"`, `"transfer"`, `"credential"`, `"api_key"`} {
		if bytes.Contains(response.Body.Bytes(), []byte(forbidden)) {
			t.Fatalf("envelope must not contain %s", forbidden)
		}
	}
}

func TestRejectedOrderReturnsAnErrorRatherThanAnEnvelope(t *testing.T) {
	// A blank corridor is not a valid corridor. The route must fail closed rather
	// than emit an envelope describing an order it could not construct.
	response := post(t, `{"id":"order-5","idempotency_key":"key-def","corridor":"","source_currency":"NGN","source_amount":"100","target_currency":"USD","target_amount":"1"}`)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d: %s", response.Code, response.Body.String())
	}
	if bytes.Contains(response.Body.Bytes(), []byte("umojaflowos.payment.order.validated.v1")) {
		t.Fatal("a refused order must not produce a validated event")
	}
}
