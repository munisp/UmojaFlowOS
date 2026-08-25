package provider

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

const webhookSecretCurrent = "current-yellowcard-webhook-secret-material"
const webhookSecretPrevious = "previous-yellowcard-webhook-secret-material"

var webhookFixedNow = time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)

type staticSecretResolver struct{ values map[string]SecretMaterial }

func (r staticSecretResolver) Resolve(_ context.Context, reference string) (SecretMaterial, error) {
	value, ok := r.values[reference]
	if !ok {
		return SecretMaterial{}, errors.New("secret reference unavailable")
	}
	return value, nil
}

type recordingEvidenceStore struct {
	mu       sync.Mutex
	evidence map[string]WebhookEvidence
}

func (s *recordingEvidenceStore) Record(_ context.Context, evidence WebhookEvidence) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.evidence == nil {
		s.evidence = make(map[string]WebhookEvidence)
	}
	key := evidence.Provider + ":" + evidence.EventID + ":" + evidence.SequenceID
	if prior, found := s.evidence[key]; found {
		if prior.PayloadSHA256 != evidence.PayloadSHA256 {
			return false, ErrWebhookEvidenceConflict
		}
		return false, nil
	}
	s.evidence[key] = evidence
	return true, nil
}

type recordingQueue struct {
	mu       sync.Mutex
	evidence map[string]WebhookEvidence
}

func (q *recordingQueue) Enqueue(_ context.Context, evidence WebhookEvidence) (bool, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.evidence == nil {
		q.evidence = make(map[string]WebhookEvidence)
	}
	key := evidence.Provider + ":" + evidence.EventID + ":" + evidence.SequenceID
	if _, found := q.evidence[key]; found {
		return false, nil
	}
	q.evidence[key] = evidence
	return true, nil
}

func webhookReceiverForTest(t *testing.T) (YellowCardWebhookReceiver, *recordingEvidenceStore, *recordingQueue) {
	t.Helper()
	prefixes, err := ParseCIDRAllowlist("203.0.113.0/24")
	if err != nil {
		t.Fatal(err)
	}
	evidence := &recordingEvidenceStore{}
	queue := &recordingQueue{}
	receiver := YellowCardWebhookReceiver{
		Config: YellowCardWebhookConfig{
			SignatureHeader: "X-YC-Signature",
			TimestampHeader: "X-YC-Timestamp",
			SourceHeader:    "X-Umoja-Provider-Source",
			MaxAge:          5 * time.Minute,
			MaxBodyBytes:    1024,
			AllowedCIDRs:    prefixes,
			CurrentSecret:   "file:///run/umoja-secrets/yellowcard/webhook-current",
			PreviousSecret:  "file:///run/umoja-secrets/yellowcard/webhook-previous",
		},
		Resolver: staticSecretResolver{values: map[string]SecretMaterial{
			"file:///run/umoja-secrets/yellowcard/webhook-current":  {Version: "yellowcard-webhook-v2", Value: []byte(webhookSecretCurrent)},
			"file:///run/umoja-secrets/yellowcard/webhook-previous": {Version: "yellowcard-webhook-v1", Value: []byte(webhookSecretPrevious)},
		}},
		Replay:   NewInMemoryReplayStore(func() time.Time { return webhookFixedNow }),
		Evidence: evidence,
		Queue:    queue,
		Now:      func() time.Time { return webhookFixedNow },
	}
	return receiver, evidence, queue
}

func signedWebhookRequest(t *testing.T, secret string, body string, timestamp time.Time, source string) *http.Request {
	t.Helper()
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(body))
	request := httptest.NewRequest(http.MethodPost, "/webhooks/yellowcard", bytes.NewBufferString(body))
	request.Header.Set("X-YC-Signature", base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	request.Header.Set("X-YC-Timestamp", timestamp.Format(time.RFC3339Nano))
	request.Header.Set("X-Umoja-Provider-Source", source)
	return request
}

func webhookBody(eventID string) string {
	return `{"id":"` + eventID + `","sequenceId":"sequence-001","status":"completed","event":"payment.updated","executedAt":"2026-08-25T11:59:00Z"}`
}

func TestYellowCardWebhookAcceptsCurrentSecretAsEvidenceOnly(t *testing.T) {
	receiver, evidence, queue := webhookReceiverForTest(t)
	response := httptest.NewRecorder()
	receiver.ServeHTTP(response, signedWebhookRequest(t, webhookSecretCurrent, webhookBody("event-current"), webhookFixedNow, "203.0.113.9"))
	if response.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", response.Code, response.Body.String())
	}
	if len(evidence.evidence) != 1 || len(queue.evidence) != 1 {
		t.Fatalf("expected exactly one durable evidence and queue record, got evidence=%d queue=%d", len(evidence.evidence), len(queue.evidence))
	}
	for _, recorded := range evidence.evidence {
		if recorded.SettlementAllowed || recorded.Reconciliation != "pending_independent_provider_and_ledger_reconciliation" || recorded.SecretVersion != "yellowcard-webhook-v2" {
			t.Fatalf("webhook evidence granted settlement authority or lost reconciliation state: %#v", recorded)
		}
	}
}

func TestYellowCardWebhookAcceptsPreviousSecretOnlyDuringRotationOverlap(t *testing.T) {
	receiver, evidence, _ := webhookReceiverForTest(t)
	response := httptest.NewRecorder()
	receiver.ServeHTTP(response, signedWebhookRequest(t, webhookSecretPrevious, webhookBody("event-previous"), webhookFixedNow, "203.0.113.10"))
	if response.Code != http.StatusAccepted {
		t.Fatalf("expected 202 for the approved previous secret, got %d: %s", response.Code, response.Body.String())
	}
	for _, recorded := range evidence.evidence {
		if recorded.SecretVersion != "yellowcard-webhook-v1" {
			t.Fatalf("expected prior secret version evidence, got %#v", recorded)
		}
	}
}

func TestYellowCardWebhookRejectsInvalidSignatureWithoutSideEffects(t *testing.T) {
	receiver, evidence, queue := webhookReceiverForTest(t)
	request := signedWebhookRequest(t, webhookSecretCurrent, webhookBody("event-invalid"), webhookFixedNow, "203.0.113.10")
	request.Header.Set("X-YC-Signature", "aW52YWxpZA==")
	response := httptest.NewRecorder()
	receiver.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", response.Code)
	}
	if len(evidence.evidence) != 0 || len(queue.evidence) != 0 {
		t.Fatal("invalid signature must not create evidence or queue work")
	}
}

func TestYellowCardWebhookRejectsStaleTimestampBeforeSecretResolution(t *testing.T) {
	receiver, evidence, queue := webhookReceiverForTest(t)
	response := httptest.NewRecorder()
	receiver.ServeHTTP(response, signedWebhookRequest(t, webhookSecretCurrent, webhookBody("event-stale"), webhookFixedNow.Add(-6*time.Minute), "203.0.113.10"))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", response.Code)
	}
	if len(evidence.evidence) != 0 || len(queue.evidence) != 0 {
		t.Fatal("stale timestamp must not create evidence or queue work")
	}
}

func TestYellowCardWebhookRejectsSourceOutsideApprovedCIDRs(t *testing.T) {
	receiver, evidence, queue := webhookReceiverForTest(t)
	response := httptest.NewRecorder()
	receiver.ServeHTTP(response, signedWebhookRequest(t, webhookSecretCurrent, webhookBody("event-source"), webhookFixedNow, "198.51.100.1"))
	if response.Code != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", response.Code)
	}
	if len(evidence.evidence) != 0 || len(queue.evidence) != 0 {
		t.Fatal("forbidden source must not create evidence or queue work")
	}
}

func TestYellowCardWebhookReplayIsIdempotent(t *testing.T) {
	receiver, evidence, queue := webhookReceiverForTest(t)
	body := webhookBody("event-replay")
	first := httptest.NewRecorder()
	receiver.ServeHTTP(first, signedWebhookRequest(t, webhookSecretCurrent, body, webhookFixedNow, "203.0.113.11"))
	if first.Code != http.StatusAccepted {
		t.Fatalf("expected first delivery 202, got %d", first.Code)
	}
	second := httptest.NewRecorder()
	receiver.ServeHTTP(second, signedWebhookRequest(t, webhookSecretCurrent, body, webhookFixedNow, "203.0.113.11"))
	if second.Code != http.StatusNoContent {
		t.Fatalf("expected replay 204, got %d", second.Code)
	}
	if len(evidence.evidence) != 1 || len(queue.evidence) != 1 {
		t.Fatal("replay must not duplicate evidence or reconciliation work")
	}
}

func TestYellowCardWebhookRejectsOversizedBody(t *testing.T) {
	receiver, evidence, queue := webhookReceiverForTest(t)
	receiver.Config.MaxBodyBytes = 32
	body := webhookBody("event-oversized")
	response := httptest.NewRecorder()
	receiver.ServeHTTP(response, signedWebhookRequest(t, webhookSecretCurrent, body, webhookFixedNow, "203.0.113.12"))
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", response.Code)
	}
	if len(evidence.evidence) != 0 || len(queue.evidence) != 0 {
		t.Fatal("oversized body must not create evidence or queue work")
	}
}

func TestParseCIDRAllowlistRejectsCatchAllAndBlankEntries(t *testing.T) {
	for _, value := range []string{"", "0.0.0.0/0", "203.0.113.0/24,", "::/0"} {
		if _, err := ParseCIDRAllowlist(value); err == nil {
			t.Fatalf("expected %q to be rejected", value)
		}
	}
	prefixes, err := ParseCIDRAllowlist("203.0.113.0/24, 2001:db8::/32")
	if err != nil || len(prefixes) != 2 || !prefixes[0].Contains(netip.MustParseAddr("203.0.113.5")) {
		t.Fatalf("expected parsed prefixes, prefixes=%v err=%v", prefixes, err)
	}
}

func TestWebhookRuntimeIsDisabledByDefault(t *testing.T) {
	handler, err := WebhookRuntimeFromEnvironment(func(string) string { return "" })
	if err != nil || handler != nil {
		t.Fatalf("expected disabled webhook runtime, handler=%v err=%v", handler, err)
	}
}

func TestWebhookRuntimeRejectsUnsafeEnablementBeforeSecretResolution(t *testing.T) {
	values := map[string]string{
		"UMOJA_YELLOWCARD_WEBHOOK_ENABLED":     "true",
		"UMOJA_YELLOWCARD_ENABLED":             "true",
		"UMOJA_YELLOWCARD_FAIL_CLOSED":         "true",
		"UMOJA_YELLOWCARD_WEBHOOK_FAIL_CLOSED": "true",
		"UMOJA_YELLOWCARD_WEBHOOK_CAN_SETTLE":  "true",
	}
	_, err := WebhookRuntimeFromEnvironment(func(key string) string { return values[key] })
	if err == nil {
		t.Fatal("expected settlement-enabled webhook configuration to be rejected")
	}
}

func TestYellowCardSigningMaterialUsesManagedReferencesOnly(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "api-key"), []byte("yellowcard-api-key-value"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "request-hmac"), []byte("yellowcard-request-hmac-secret-material"), 0o600); err != nil {
		t.Fatal(err)
	}
	values := map[string]string{
		"UMOJA_PROVIDER_MATERIAL_ROOT":              directory,
		"UMOJA_YELLOWCARD_API_KEY_SECRET_REFERENCE": "file://" + filepath.Join(directory, "api-key"),
		"UMOJA_YELLOWCARD_HMAC_SECRET_REFERENCE":    "file://" + filepath.Join(directory, "request-hmac"),
	}
	material, err := YellowCardSigningMaterialFromEnvironment(context.Background(), func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	_, signature, err := material.Signer.SignYellowCard(context.Background(), []byte("non-sensitive test message"))
	if err != nil || signature == "" || material.APIKeyVersion == "" || material.HMACVersion == "" {
		t.Fatalf("expected usable signer with non-sensitive version references, material=%#v err=%v", material, err)
	}
}
