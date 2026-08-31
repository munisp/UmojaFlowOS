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

	"github.com/munisp/UmojaFlowOS/services/payment-engine/multirail"
)

// YellowCardExecutionHandler authorises a Send only through a private caller
// that proves possession of a deployment-managed approval HMAC. The caller's
// approval is distinct from provider signing material; neither is accepted from
// a customer-facing API or browser form.
type UnknownStateEnqueuer interface {
	EnqueueUnknown(context.Context, multirail.UnknownState) error
}

type YellowCardExecutionHandler struct {
	Sender         YellowCardSender
	ApprovalSecret []byte
	Now            func() time.Time
	MaxAge         time.Duration
	MaxBodyBytes   int64
	Coordinator    *multirail.Coordinator
	SecondaryRail  multirail.Rail
	UnknownStore   UnknownStateEnqueuer
}

// NewCoordinatedYellowCardExecutionHandler is the production composition
// boundary. It refuses an incomplete failover topology so UNKNOWN outcomes
// cannot be accepted without durable reconciliation storage.
func NewCoordinatedYellowCardExecutionHandler(sender YellowCardSender, approvalSecret []byte, coordinator *multirail.Coordinator, secondary multirail.Rail, store UnknownStateEnqueuer, now func() time.Time, maxAge time.Duration, maxBodyBytes int64) (YellowCardExecutionHandler, error) {
	h := YellowCardExecutionHandler{Sender: sender, ApprovalSecret: approvalSecret, Coordinator: coordinator, SecondaryRail: secondary, UnknownStore: store, Now: now, MaxAge: maxAge, MaxBodyBytes: maxBodyBytes}
	if err := h.Validate(); err != nil {
		return YellowCardExecutionHandler{}, err
	}
	return h, nil
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
	if h.Coordinator != nil && (h.SecondaryRail == nil || h.UnknownStore == nil) {
		return errors.New("coordinated Yellow Card execution requires a secondary rail and durable UNKNOWN store")
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
	var providerReference, providerStatus, sequenceID string
	if h.Coordinator == nil {
		result, submitErr := h.Sender.SubmitSend(r.Context(), send)
		if submitErr != nil {
			http.Error(w, "provider Send request was not accepted", http.StatusServiceUnavailable)
			return
		}
		providerReference, providerStatus, sequenceID = result.Reference, result.Status, result.SequenceID
	} else {
		primary := YellowCardMultiRail{Client: nil, Send: send}
		if client, ok := h.Sender.(*YellowCardClient); ok {
			primary.Client = client
		} else {
			http.Error(w, "coordinator requires a Yellow Card client rail", http.StatusServiceUnavailable)
			return
		}
		intent := multirail.Intent{ID: send.SequenceID, IdempotencyKey: send.SequenceID, Payload: body}
		result, executeErr := h.Coordinator.Execute(r.Context(), intent, primary, h.SecondaryRail)
		if executeErr != nil {
			if errors.Is(executeErr, multirail.ErrUnknownOutcome) {
				if h.UnknownStore == nil || h.UnknownStore.EnqueueUnknown(r.Context(), multirail.UnknownState{Intent: intent, PrimaryRail: primary.Name(), ObservedStatus: multirail.Unknown, LastError: executeErr.Error()}) != nil {
					http.Error(w, "provider outcome unresolved and reconciliation queue unavailable", http.StatusServiceUnavailable)
					return
				}
				http.Error(w, "provider outcome unresolved; reconciliation required", http.StatusServiceUnavailable)
				return
			}
			http.Error(w, "provider Send request was not accepted", http.StatusServiceUnavailable)
			return
		}
		providerReference, providerStatus, sequenceID = result.ProviderRef, string(result.Status), send.SequenceID
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"provider_reference": providerReference,
		"provider_status":    providerStatus,
		"sequence_id":        sequenceID,
		"finality_state":     "provider_pending",
	})
}
