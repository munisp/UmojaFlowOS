package provider

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func yellowCardTestSecret() []byte { return []byte(strings.Repeat("y", 32)) }

func TestYellowCardRFQRequiresDocumentedHMACAndReturnsOfferOnly(t *testing.T) {
	secret := yellowCardTestSecret()
	timestamp := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/custody/rfq" || request.Header.Get("X-YC-Timestamp") != timestamp.Format(time.RFC3339Nano) {
			t.Fatalf("unexpected RFQ request %s %s", request.Method, request.URL.Path)
		}
		var payload yellowCardRFQRequest
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		body, _ := json.Marshal(payload)
		digest := sha256.Sum256(body)
		message := timestamp.Format(time.RFC3339Nano) + "/custody/rfq" + http.MethodPost + base64.StdEncoding.EncodeToString(digest[:])
		mac := hmac.New(sha256.New, secret)
		_, _ = mac.Write([]byte(message))
		expectedAuthorization := "YcHmacV1 test-key:" + base64.StdEncoding.EncodeToString(mac.Sum(nil))
		if request.Header.Get("Authorization") != expectedAuthorization {
			t.Fatal("request did not carry the documented Yellow Card HMAC authorization")
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusCreated)
		_, _ = writer.Write([]byte(`{"id":"rfq-verified","idempotencyKey":"0f8b1a2c-3d4e-4f50-8a61-b2c3d4e5f607","sourceCurrency":"USDC","sourceCurrencyType":"crypto","destinationCurrency":"NGN","destinationCurrencyType":"fiat","amount":1250,"status":"RFQ_PENDING_REVIEW"}`))
	}))
	defer server.Close()

	signer, err := NewHMACYellowCardSigner("test-key", secret)
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewYellowCardClient(YellowCardConfig{BaseURL: server.URL + "/custody", Signer: signer, Now: func() time.Time { return timestamp }, AllowInsecureLoopback: true})
	if err != nil {
		t.Fatal(err)
	}
	result, err := client.CreateRFQ(context.Background(), YellowCardRFQ{IdempotencyKey: "0f8b1a2c-3d4e-4f50-8a61-b2c3d4e5f607", Corridor: "NIGERIA_NGN", SourceStablecoin: "USDC", DestinationCurrency: "NGN", Amount: "1250"})
	if err != nil {
		t.Fatal(err)
	}
	if result.Reference != "rfq-verified" || result.Status != "RFQ_PENDING_REVIEW" {
		t.Fatalf("expected reviewable RFQ reference, got %#v", result)
	}
}

func TestYellowCardRFQFailsClosedBeforeNetwork(t *testing.T) {
	signer, err := NewHMACYellowCardSigner("test-key", yellowCardTestSecret())
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewYellowCardClient(YellowCardConfig{BaseURL: "https://yellow.example/custody", Signer: signer})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.CreateRFQ(context.Background(), YellowCardRFQ{IdempotencyKey: "not-a-uuid", Corridor: "NIGERIA_NGN", SourceStablecoin: "DAI", DestinationCurrency: "NGN", Amount: "0"}); err == nil {
		t.Fatal("expected unsupported stablecoin and malformed RFQ to be rejected")
	}
	if _, err := NewYellowCardClient(YellowCardConfig{BaseURL: "http://yellow.example", Signer: signer}); err == nil {
		t.Fatal("expected remote plaintext transport to be rejected")
	}
}

func TestYellowCardWebhookSignatureAndLifecycleMetadata(t *testing.T) {
	secret := yellowCardTestSecret()
	body := []byte(`{"id":"provider-event-1","sequenceId":"sequence-1","status":"completed","event":"SEND.COMPLETE","executedAt":"2026-08-19T12:00:00Z"}`)
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(body)
	signature := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	event, err := VerifyYellowCardWebhook(secret, signature, body)
	if err != nil || event.Event != "SEND.COMPLETE" {
		t.Fatalf("expected verified webhook metadata, event=%#v err=%v", event, err)
	}
	if _, err := VerifyYellowCardWebhook(secret, "not-base64", body); err == nil {
		t.Fatal("expected malformed webhook signature to be rejected")
	}
}
