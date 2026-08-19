package provider

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCircleMintUSDCBalanceObservationIsReadOnly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/v1/businessAccount/balances" || r.URL.Query().Get("walletId") != "wallet-1" || r.Header.Get("Authorization") != "Bearer circle-boundary-key" {
			t.Fatalf("unexpected Circle Mint balance request")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"available":[{"amount":"25.10","currency":"USDC"},{"amount":"7","currency":"USD"}],"unsettled":[{"amount":"0","currency":"USDC"}]}}`))
	}))
	defer server.Close()
	client, err := NewCircleMintClient(CircleMintConfig{BaseURL: server.URL, APIKey: "circle-boundary-key", AllowInsecureLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	balances, err := client.ListUSDCBalances(context.Background(), "wallet-1")
	if err != nil || len(balances.Available) != 1 || balances.Available[0].Amount != "25.10" || len(balances.Unsettled) != 1 {
		t.Fatalf("expected observed USDC-only balances, balances=%#v err=%v", balances, err)
	}
}

func TestCircleMintFailsClosedBeforeNetwork(t *testing.T) {
	if _, err := NewCircleMintClient(CircleMintConfig{BaseURL: "http://circle.example", APIKey: "circle-boundary-key"}); err == nil {
		t.Fatal("expected plaintext remote endpoint rejection")
	}
	if _, err := NewCircleMintClient(CircleMintConfig{BaseURL: "https://api.circle.com"}); err == nil {
		t.Fatal("expected missing API key rejection")
	}
}
