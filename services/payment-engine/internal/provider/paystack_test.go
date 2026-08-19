package provider

import (
	"context"
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPaystackVerificationAndWebhookRemainProviderReportedOnly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/transaction/verify/ref_123" || r.Header.Get("Authorization") != "Bearer sk_test_boundary" {
			t.Fatalf("unexpected request path or authorization")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":true,"data":{"reference":"ref_123","status":"success","amount":5000,"currency":"NGN"}}`))
	}))
	defer server.Close()
	client, err := NewPaystackClient(PaystackConfig{BaseURL: server.URL, SecretKey: "sk_test_boundary", AllowInsecureLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.VerifyTransaction(context.Background(), "ref_123")
	if err != nil || result.Reference != "ref_123" || result.Currency != "NGN" {
		t.Fatalf("expected provider-reported verification, result=%#v err=%v", result, err)
	}
	body := []byte(`{"event":"charge.success","data":{"reference":"ref_123","status":"success"}}`)
	mac := hmac.New(sha512.New, []byte("sk_test_boundary"))
	_, _ = mac.Write(body)
	event, err := VerifyPaystackWebhook("sk_test_boundary", hex.EncodeToString(mac.Sum(nil)), body)
	if err != nil || event.Event != "charge.success" {
		t.Fatalf("expected verified lifecycle metadata, event=%#v err=%v", event, err)
	}
}

func TestPaystackFailsClosedBeforeNetwork(t *testing.T) {
	if _, err := NewPaystackClient(PaystackConfig{BaseURL: "http://paystack.example", SecretKey: "sk_test_boundary"}); err == nil {
		t.Fatal("expected plaintext remote endpoint rejection")
	}
	client, err := NewPaystackClient(PaystackConfig{BaseURL: "https://api.paystack.co", SecretKey: "sk_test_boundary"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.VerifyTransaction(context.Background(), "bad reference with spaces"); err == nil {
		t.Fatal("expected malformed reference rejection")
	}
	if _, err := VerifyPaystackWebhook("sk_test_boundary", strings.Repeat("g", 128), []byte(`{}`)); err == nil {
		t.Fatal("expected malformed signature rejection")
	}
}
