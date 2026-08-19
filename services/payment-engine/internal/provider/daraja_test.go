package provider

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDarajaOAuthValidationDoesNotExposeExecution(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/oauth/v1/generate" || r.URL.Query().Get("grant_type") != "client_credentials" || r.Header.Get("Authorization") != "Basic Y29uc3VtZXIta2V5OmNvbnN1bWVyLXNlY3JldA==" {
			t.Fatalf("unexpected OAuth request")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"access_token":"provider-token","expires_in":"3599"}`))
	}))
	defer server.Close()
	client, err := NewDarajaClient(DarajaConfig{BaseURL: server.URL, ConsumerKey: "consumer-key", ConsumerSecret: "consumer-secret", AllowInsecureLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	token, err := client.FetchAccessToken(context.Background())
	if err != nil || token.AccessToken != "provider-token" || token.ExpiresIn != 3599 {
		t.Fatalf("expected OAuth token validation, token=%#v err=%v", token, err)
	}
}

func TestDarajaOAuthAcceptsNumericLifetime(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"access_token":"provider-token","expires_in":3600}`))
	}))
	defer server.Close()
	client, err := NewDarajaClient(DarajaConfig{BaseURL: server.URL, ConsumerKey: "consumer-key", ConsumerSecret: "consumer-secret", AllowInsecureLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	if token, err := client.FetchAccessToken(context.Background()); err != nil || token.ExpiresIn != 3600 {
		t.Fatalf("expected numeric lifetime, token=%#v err=%v", token, err)
	}
}

func TestDarajaFailsClosedBeforeNetwork(t *testing.T) {
	if _, err := NewDarajaClient(DarajaConfig{BaseURL: "http://daraja.example", ConsumerKey: "key", ConsumerSecret: "secret"}); err == nil {
		t.Fatal("expected plaintext remote endpoint rejection")
	}
	if _, err := NewDarajaClient(DarajaConfig{BaseURL: "https://api.safaricom.co.ke"}); err == nil {
		t.Fatal("expected missing deployment credentials rejection")
	}
}
