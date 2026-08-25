package provider

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type recordingSender struct {
	called bool
}

func (s *recordingSender) SubmitSend(_ context.Context, send YellowCardSend) (YellowCardSendResult, error) {
	s.called = true
	return YellowCardSendResult{Reference: "provider-1", SequenceID: send.SequenceID, Status: "created"}, nil
}

func signedExecutionRequest(t *testing.T, secret []byte, at time.Time, send YellowCardSend) *http.Request {
	t.Helper()
	body, err := json.Marshal(send)
	if err != nil {
		t.Fatalf("marshal send: %v", err)
	}
	timestamp := at.UTC().Format(time.RFC3339Nano)
	digest := sha256.Sum256(body)
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write([]byte(timestamp + http.MethodPost + "/v1/providers/yellowcard/sends" + base64.StdEncoding.EncodeToString(digest[:])))
	request := httptest.NewRequest(http.MethodPost, "http://payment-engine/v1/providers/yellowcard/sends", bytes.NewReader(body))
	request.Header.Set("X-Umoja-Execution-Timestamp", timestamp)
	request.Header.Set("X-Umoja-Execution-Signature", base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	return request
}

func TestExecutionHandlerRequiresSignedFreshApproval(t *testing.T) {
	secret := []byte("0123456789abcdef")
	when := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	sender := &recordingSender{}
	handler := YellowCardExecutionHandler{Sender: sender, ApprovalSecret: secret, Now: func() time.Time { return when }, MaxAge: 5 * time.Minute, MaxBodyBytes: 64 * 1024}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, signedExecutionRequest(t, secret, when, validYellowCardSend()))
	if response.Code != http.StatusAccepted || !sender.called {
		t.Fatalf("expected accepted signed provider request, got status=%d called=%v", response.Code, sender.called)
	}
	stale := httptest.NewRecorder()
	handler.ServeHTTP(stale, signedExecutionRequest(t, secret, when.Add(-6*time.Minute), validYellowCardSend()))
	if stale.Code != http.StatusUnauthorized {
		t.Fatalf("expected stale request rejection, got %d", stale.Code)
	}
}

func TestExecutionHandlerRejectsInvalidSignatureBeforeProviderCall(t *testing.T) {
	secret := []byte("0123456789abcdef")
	when := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	sender := &recordingSender{}
	handler := YellowCardExecutionHandler{Sender: sender, ApprovalSecret: secret, Now: func() time.Time { return when }, MaxAge: 5 * time.Minute, MaxBodyBytes: 64 * 1024}
	request := signedExecutionRequest(t, secret, when, validYellowCardSend())
	request.Header.Set("X-Umoja-Execution-Signature", "bad")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || sender.called {
		t.Fatalf("invalid authorization must fail before provider call, status=%d called=%v", response.Code, sender.called)
	}
}
