package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/provider"
)

// The point of these tests is that the metrics are *measured*. It would be easy
// to ship an endpoint returning plausible constants and no test would notice, so
// each assertion drives real traffic through the service and then requires the
// counters to reflect exactly that traffic.

func metricsFrom(t *testing.T, handler http.Handler) metricsSnapshot {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/metrics", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("metrics returned %d", recorder.Code)
	}
	var snapshot metricsSnapshot
	if err := json.Unmarshal(recorder.Body.Bytes(), &snapshot); err != nil {
		t.Fatalf("metrics response is not valid JSON: %v", err)
	}
	return snapshot
}

func TestMetricsStartAtZero(t *testing.T) {
	handler := newHandler(time.Now)
	snapshot := metricsFrom(t, handler)
	if snapshot.ValidationsTotal != 0 || snapshot.ValidationsInvalid != 0 || snapshot.ValidationsFailed != 0 {
		t.Fatalf("a service that has served nothing must report zero, got %+v", snapshot)
	}
	if snapshot.Service != "payment-engine" || snapshot.Language != "go" {
		t.Fatalf("metrics must identify their own service, got %+v", snapshot)
	}
	if snapshot.ObservedAt == "" {
		t.Fatal("metrics must carry an observation time so staleness is visible")
	}
}

func TestMetricsCountRealTraffic(t *testing.T) {
	handler := newHandler(time.Now)

	// Three valid validations.
	body := `{"id":"11111111-1111-1111-1111-111111111111","idempotency_key":"key-1","corridor":"NIGERIA_NGN","source_currency":"NGN","source_amount":"100.00","target_currency":"KES","target_amount":"25.00"}`
	for i := 0; i < 3; i++ {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/v1/orders/validate", strings.NewReader(body)))
	}

	// Two malformed requests.
	for i := 0; i < 2; i++ {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/v1/orders/validate", strings.NewReader("not json")))
	}

	snapshot := metricsFrom(t, handler)
	if snapshot.ValidationsTotal != 5 {
		t.Fatalf("expected 5 total validations, got %d", snapshot.ValidationsTotal)
	}
	if snapshot.ValidationsInvalid != 2 {
		t.Fatalf("expected 2 invalid validations, got %d", snapshot.ValidationsInvalid)
	}
}

func TestMetricsUptimeAdvancesWithTheClock(t *testing.T) {
	// A fixed clock proves uptime is derived from the clock rather than being a
	// constant that happens to look reasonable.
	current := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	handler := newHandler(func() time.Time { return current })

	if uptime := metricsFrom(t, handler).UptimeSeconds; uptime != 0 {
		t.Fatalf("expected zero uptime at start, got %d", uptime)
	}
	current = current.Add(90 * time.Second)
	if uptime := metricsFrom(t, handler).UptimeSeconds; uptime != 90 {
		t.Fatalf("expected 90s uptime, got %d", uptime)
	}
}

func TestMetricsRestateThatExecutionIsDisabled(t *testing.T) {
	// The dashboard shows this field; a service that stopped asserting it would
	// be a service whose gate had changed.
	snapshot := metricsFrom(t, newHandler(time.Now))
	if snapshot.ProviderExecution != "disabled_without_verified_provider" {
		t.Fatalf("unexpected provider execution posture: %q", snapshot.ProviderExecution)
	}
}

func TestMetricsExposeTheConfiguredLedgerRuntimePosture(t *testing.T) {
	snapshot := metricsFrom(t, newHandler(time.Now, "configured_reachable_tigerbeetle"))
	if snapshot.LedgerBackend != "configured_reachable_tigerbeetle" {
		t.Fatalf("unexpected ledger posture: %q", snapshot.LedgerBackend)
	}

	recorder := httptest.NewRecorder()
	newHandler(time.Now, "configured_reachable_tigerbeetle").ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, "/healthz", nil),
	)
	var health map[string]string
	if err := json.Unmarshal(recorder.Body.Bytes(), &health); err != nil {
		t.Fatalf("health response is not valid JSON: %v", err)
	}
	if health["ledger_backend"] != "configured_reachable_tigerbeetle" {
		t.Fatalf("health must expose the configured ledger posture, got %#v", health)
	}
}

func TestMetricsExposeSignerRetryCounters(t *testing.T) {
	signerMetrics := &provider.SignerRetryMetrics{}
	signerMetrics.AttemptsTotal.Store(7)
	signerMetrics.RetriesTotal.Store(3)
	signerMetrics.RetryExhaustedTotal.Store(1)
	signerMetrics.NonRetryableErrorsTotal.Store(2)

	handler := newHandlerWithSignerMetrics(time.Now, nil, nil, nil, signerMetrics)
	snapshot := metricsFrom(t, handler)
	if snapshot.SignerAttemptsTotal != 7 || snapshot.SignerRetriesTotal != 3 || snapshot.SignerRetryExhaustedTotal != 1 || snapshot.SignerNonRetryableTotal != 2 {
		t.Fatalf("signer metrics=%+v", snapshot)
	}
}
