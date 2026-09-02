package settlement

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestVerifyWebhookHMACWithTimestamp(t *testing.T) {
	body := []byte(`{"event":"settled","tenant_id":"tenant-a"}`)
	secret := "webhook-secret"
	now := time.Unix(1_700_000_100, 0)
	timestamp := fmt.Sprintf("%d", now.Add(-10*time.Second).Unix())
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp + "."))
	_, _ = mac.Write(body)
	sig := "t=" + timestamp + ",v1=" + hex.EncodeToString(mac.Sum(nil))
	if !VerifyWebhookHMACWithTimestamp(body, sig, secret, now, 5*time.Minute, 30*time.Second) {
		t.Fatal("valid timestamped signature rejected")
	}
	cases := []struct {
		name, signature string
		body            []byte
		want            bool
	}{
		{"tampered body", sig, []byte(`{"event":"failed"}`), false},
		{"stale", fmt.Sprintf("t=%d,%s", now.Add(-6*time.Minute).Unix(), sig[strings.Index(sig, ",")+1:]), body, false},
		{"future", fmt.Sprintf("t=%d,%s", now.Add(31*time.Second).Unix(), sig[strings.Index(sig, ",")+1:]), body, false},
		{"duplicate timestamp", sig + ",t=" + timestamp, body, false},
		{"unknown field", sig + ",v0=abcd", body, false},
		{"bad digest", "t=" + timestamp + ",v1=00", body, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := VerifyWebhookHMACWithTimestamp(tc.body, tc.signature, secret, now, 5*time.Minute, 30*time.Second); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}
