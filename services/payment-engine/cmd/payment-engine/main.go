package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/domain"
	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/eventing"
)

type validationRequest struct {
	ID             string `json:"id"`
	IdempotencyKey string `json:"idempotency_key"`
	Corridor       string `json:"corridor"`
	SourceCurrency string `json:"source_currency"`
	SourceAmount   string `json:"source_amount"`
	TargetCurrency string `json:"target_currency"`
	TargetAmount   string `json:"target_amount"`
	PolicyOutcome  string `json:"policy_outcome,omitempty"`
	PolicyVersion  string `json:"policy_version,omitempty"`
	// CorrelationID ties the validation to the caller's request. Supplied by the
	// control plane; generated here only when absent, never silently reused.
	CorrelationID string `json:"correlation_id,omitempty"`
}

// validationPayload is the body carried inside the versioned event envelope.
// It states the resulting lifecycle status and restates, explicitly, that no
// provider execution has been authorised.
type validationPayload struct {
	OrderID           string        `json:"order_id"`
	Corridor          string        `json:"corridor"`
	Status            domain.Status `json:"status"`
	ProviderExecution string        `json:"provider_execution"`
}

// randomID produces an event identifier. It is not derived from the order so a
// replayed validation is a distinct, individually traceable event.
func randomID() (string, error) {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func newHandler(now func() time.Time) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"service": "payment-engine", "status": "healthy", "provider_execution": "disabled_without_verified_provider"})
	})
	mux.HandleFunc("POST /v1/orders/validate", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var input validationRequest
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			http.Error(w, "invalid JSON request", http.StatusBadRequest)
			return
		}
		order, err := domain.NewOrder(input.ID, input.IdempotencyKey, domain.Corridor(input.Corridor), domain.Money{Currency: input.SourceCurrency, Amount: input.SourceAmount}, domain.Money{Currency: input.TargetCurrency, Amount: input.TargetAmount}, now())
		if err != nil {
			http.Error(w, err.Error(), http.StatusUnprocessableEntity)
			return
		}
		if input.PolicyOutcome != "" || input.PolicyVersion != "" {
			if err := order.ApplyPolicy(domain.PolicyDecision{Outcome: input.PolicyOutcome, Version: input.PolicyVersion}); err != nil {
				http.Error(w, err.Error(), http.StatusUnprocessableEntity)
				return
			}
		}

		correlationID := input.CorrelationID
		if correlationID == "" {
			generated, err := randomID()
			if err != nil {
				http.Error(w, "could not derive a correlation id", http.StatusInternalServerError)
				return
			}
			correlationID = generated
		}
		eventID, err := randomID()
		if err != nil {
			http.Error(w, "could not derive an event id", http.StatusInternalServerError)
			return
		}

		// The control plane parses this response with a strict versioned schema,
		// so the route returns the published envelope rather than an ad-hoc body.
		envelope, err := eventing.NewOrderValidated(eventID, correlationID, now(), validationPayload{
			OrderID:           order.ID,
			Corridor:          string(order.Corridor),
			Status:            order.Status,
			ProviderExecution: "disabled_without_verified_provider",
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(envelope)
	})
	return mux
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8081"
	}
	if err := http.ListenAndServe(":"+port, newHandler(time.Now)); err != nil {
		panic(err)
	}
}
