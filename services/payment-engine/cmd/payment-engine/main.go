package main

import (
	"encoding/json"
	"net/http"
	"os"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/domain"
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
}

type validationResponse struct {
	Status            domain.Status `json:"status"`
	ProviderExecution string        `json:"provider_execution"`
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
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(validationResponse{Status: order.Status, ProviderExecution: "disabled_without_verified_provider"})
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
