package provider

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

// YellowCardExecutionHandler authorises a Send only through a private caller
// that proves possession of a deployment-managed approval HMAC. The caller's
// approval is distinct from provider signing material; neither is accepted from
// a customer-facing API or browser form.
type YellowCardExecutionHandler struct {
	Sender         YellowCardSender
	ApprovalSecret []byte
	Now            func() time.Time
	MaxAge         time.Duration
	MaxBodyBytes   int64
}

func (h YellowCardExecutionHandler) Validate() error {
	if h.Sender == nil || len(h.ApprovalSecret) < 16 {
		return errors.New("Yellow Card execution handler is not configured")
	}
	if h.Now == nil {
		return errors.New("Yellow Card execution handler requires a clock")
	}
	if h.MaxAge <= 0 || h.MaxBodyBytes <= 0 {
		return errors.New("Yellow Card execution handler requires bounded freshness and body limits")
	}
	return nil
}

func (h YellowCardExecutionHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := h.Validate(); err != nil {
		http.Error(w, "provider execution is unavailable", http.StatusServiceUnavailable)
		return
	}
	defer r.Body.Close()
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, h.MaxBodyBytes))
	if err != nil || len(body) == 0 {
		http.Error(w, "invalid execution request body", http.StatusBadRequest)
		return
	}
	timestamp := r.Header.Get("X-Umoja-Execution-Timestamp")
	signature := r.Header.Get("X-Umoja-Execution-Signature")
	when, err := time.Parse(time.RFC3339Nano, timestamp)
	if err != nil || h.Now().UTC().Sub(when.UTC()).Abs() > h.MaxAge {
		http.Error(w, "execution approval timestamp is outside the accepted window", http.StatusUnauthorized)
		return
	}
	provided, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		http.Error(w, "execution approval signature is invalid", http.StatusUnauthorized)
		return
	}
	digest := sha256.Sum256(body)
	mac := hmac.New(sha256.New, h.ApprovalSecret)
	_, _ = mac.Write([]byte(timestamp + http.MethodPost + r.URL.EscapedPath() + base64.StdEncoding.EncodeToString(digest[:])))
	expected := mac.Sum(nil)
	if len(provided) != len(expected) || !hmac.Equal(provided, expected) {
		http.Error(w, "execution approval signature is invalid", http.StatusUnauthorized)
		return
	}
	var send YellowCardSend
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&send); err != nil {
		http.Error(w, "execution request does not match the Send contract", http.StatusUnprocessableEntity)
		return
	}
	result, err := h.Sender.SubmitSend(context.Background(), send)
	if err != nil {
		http.Error(w, "provider Send request was not accepted", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"provider_reference": result.Reference,
		"provider_status":    result.Status,
		"sequence_id":        result.SequenceID,
		"finality_state":     "provider_pending",
	})
}
