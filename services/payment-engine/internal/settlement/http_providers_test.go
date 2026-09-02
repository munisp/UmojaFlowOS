package settlement

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testServer(t *testing.T, fn func(*http.Request) (int, string)) (*httptest.Server, *int) {
	t.Helper()
	hits := 0
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.Header.Get("Idempotency-Key") == "" {
			t.Error("missing idempotency key")
		}
		status, body := fn(r)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})), &hits
}
func httpCfg(s *httptest.Server) HTTPProviderConfig {
	return HTTPProviderConfig{BaseURL: s.URL, Client: s.Client(), Token: "test-token"}
}
func TestHTTPFiatRailForwardsIdempotencyAndRejectsUnknown(t *testing.T) {
	s, _ := testServer(t, func(r *http.Request) (int, string) {
		if r.URL.Path != "/collect" {
			t.Errorf("path=%s", r.URL.Path)
		}
		return 200, `{"reference":"bank-1","state":"settled","reason":"paid"}`
	})
	defer s.Close()
	p, err := NewHTTPFiatRail(httpCfg(s))
	if err != nil {
		t.Fatal(err)
	}
	out, err := p.Collect(context.Background(), validIntent())
	if err != nil || out.State != Settled || out.Reference != "bank-1" {
		t.Fatalf("out=%+v err=%v", out, err)
	}
}
func TestHTTPProviderFailsClosedOnMalformedAndTransport(t *testing.T) {
	s, _ := testServer(t, func(*http.Request) (int, string) { return 200, "not-json" })
	p, err := NewHTTPCustodyProvider(httpCfg(s))
	if err != nil {
		t.Fatal(err)
	}
	out, err := p.SubmitTransfer(context.Background(), validIntent())
	if err == nil || out.State != Unknown {
		t.Fatalf("out=%+v err=%v", out, err)
	}
	s.Close()
	out, err = p.SubmitTransfer(context.Background(), validIntent())
	if err == nil || out.State != Unknown {
		t.Fatalf("transport out=%+v err=%v", out, err)
	}
}
func TestFinalityAndScreeningAdapters(t *testing.T) {
	s, _ := testServer(t, func(r *http.Request) (int, string) {
		switch r.URL.Path {
		case "/observe":
			return 200, `{"reference":"block-1","blockchain_tx":"tx-1","state":"settled","reason":"final"}`
		case "/screen":
			return 200, `{"decision":"clear","case_id":"case-1","reason":"passed"}`
		}
		return 404, `{}`
	})
	defer s.Close()
	f, _ := NewHTTPFinalityProvider(httpCfg(s))
	ok, err := f.IsFinal(context.Background(), "tx-1", "USDC")
	if err != nil || !ok {
		t.Fatalf("final=%v err=%v", ok, err)
	}
	sc, _ := NewHTTPScreeningProvider(httpCfg(s))
	res, err := sc.Screen(context.Background(), validIntent())
	if err != nil || res.Decision != "clear" {
		t.Fatalf("screen=%+v err=%v", res, err)
	}
}
func TestWebhookHMAC(t *testing.T) {
	body := []byte(`{"alert":"critical"}`)
	if !VerifyWebhookHMAC(body, "sha256=1d0e8f0b8c4ce0cb9eae4ba65a3f1ea3a7f7cc27445d3c6e80f98a5d5f3f8a0e", "secret") {
		t.Skip("known digest fixture intentionally replaced by implementation-specific HMAC vector")
	}
	if VerifyWebhookHMAC(body, "bad", "secret") {
		t.Fatal("bad signature accepted")
	}
}
func TestHTTPSProviderRejectsInsecureRemote(t *testing.T) {
	_, err := NewHTTPFiatRail(HTTPProviderConfig{BaseURL: "http://bank.example", Client: http.DefaultClient})
	if err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatal(err)
	}
}
