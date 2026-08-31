package provider

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/multirail"
)

func validNigerianRailIntent(t *testing.T) multirail.Intent {
	t.Helper()
	payload, err := json.Marshal(NigerianBankTransfer{
		SequenceID: "ng-order-1001", AmountMinor: 2500000, Currency: "NGN",
		BankCode: "044", AccountNumber: "0123456789", AccountName: "Approved Beneficiary",
		Narration: "approved invoice settlement",
	})
	if err != nil {
		t.Fatal(err)
	}
	return multirail.Intent{ID: "ng-order-1001", IdempotencyKey: "ng-order-1001", Payload: payload}
}

func TestNigerianBankRailSubmitsWithBoundIdempotency(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/transfers" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-token" || r.Header.Get("Idempotency-Key") != "ng-order-1001" || r.Header.Get("X-Umoja-Payload-SHA256") == "" {
			t.Fatal("required authenticated idempotency headers missing")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = io.WriteString(w, `{"id":"bank-transfer-1","sequenceId":"ng-order-1001","status":"accepted"}`)
	}))
	defer server.Close()
	client, err := NewNigerianBankRailClient(NigerianBankRailConfig{BaseURL: server.URL, BearerToken: "test-token", AllowInsecureLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.Submit(context.Background(), validNigerianRailIntent(t))
	if err != nil || result.Status != multirail.Pending || result.ProviderRef != "bank-transfer-1" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestNigerianBankRailLookupNeverSubmits(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || !strings.HasPrefix(r.URL.Path, "/v1/transfers/") {
			t.Fatalf("unexpected lookup %s %s", r.Method, r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"bank-transfer-1","sequenceId":"ng-order-1001","status":"complete"}`)
	}))
	defer server.Close()
	client, err := NewNigerianBankRailClient(NigerianBankRailConfig{BaseURL: server.URL, BearerToken: "test-token", AllowInsecureLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.Query(context.Background(), validNigerianRailIntent(t))
	if err != nil || result.Status != multirail.Settled || result.ProviderRef != "bank-transfer-1" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestNigerianBankRailUnknownStatusBlocksFallback(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"id":"bank-transfer-1","sequenceId":"ng-order-1001","status":"provider_new_state"}`)
	}))
	defer server.Close()
	client, err := NewNigerianBankRailClient(NigerianBankRailConfig{BaseURL: server.URL, BearerToken: "test-token", AllowInsecureLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.Submit(context.Background(), validNigerianRailIntent(t))
	if err != nil || result.Status != multirail.Unknown || result.RetryableWithoutBusinessEffect {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}
