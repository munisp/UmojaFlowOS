package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"sync/atomic"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/domain"
	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/eventing"
	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/ledger"
	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/provider"
)

// serviceMetrics holds counters the service actually observes while running.
//
// Everything here is measured, never estimated: each field is incremented at the
// point the corresponding event happens. A metric this service cannot observe is
// absent rather than reported as zero, because a fabricated zero is worse than a
// missing field — it reads as "nothing is wrong".
type serviceMetrics struct {
	startedAt          time.Time
	validationsTotal   atomic.Uint64
	validationsInvalid atomic.Uint64
	validationsFailed  atomic.Uint64
}

// metricsSnapshot is the wire form. The control plane reads it as-is.
type metricsSnapshot struct {
	Service            string `json:"service"`
	Language           string `json:"language"`
	UptimeSeconds      int64  `json:"uptime_seconds"`
	ValidationsTotal   uint64 `json:"validations_total"`
	ValidationsInvalid uint64 `json:"validations_invalid"`
	ValidationsFailed  uint64 `json:"validations_failed"`
	ObservedAt         string `json:"observed_at"`
	ProviderExecution  string `json:"provider_execution"`
	LedgerBackend      string `json:"ledger_backend"`
}

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

func newHandler(now func() time.Time, configuredLedgerBackend ...string) http.Handler {
	return newHandlerWithWebhook(now, nil, configuredLedgerBackend...)
}

func newHandlerWithWebhook(now func() time.Time, webhook http.Handler, configuredLedgerBackend ...string) http.Handler {
	ledgerBackend := "disabled_without_deployed_tigerbeetle"
	if len(configuredLedgerBackend) > 0 && configuredLedgerBackend[0] != "" {
		ledgerBackend = configuredLedgerBackend[0]
	}
	mux := http.NewServeMux()
	metrics := &serviceMetrics{startedAt: now()}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"service": "payment-engine", "status": "healthy", "provider_execution": "disabled_without_verified_provider", "ledger_backend": ledgerBackend})
	})
	// Metrics the service has actually counted since it started. The control
	// plane displays these with their observation time so a stale reading is
	// visibly stale rather than silently presented as current.
	mux.HandleFunc("GET /v1/metrics", func(w http.ResponseWriter, _ *http.Request) {
		observed := now()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(metricsSnapshot{
			Service:            "payment-engine",
			Language:           "go",
			UptimeSeconds:      int64(observed.Sub(metrics.startedAt).Seconds()),
			ValidationsTotal:   metrics.validationsTotal.Load(),
			ValidationsInvalid: metrics.validationsInvalid.Load(),
			ValidationsFailed:  metrics.validationsFailed.Load(),
			ObservedAt:         observed.UTC().Format(time.RFC3339),
			ProviderExecution:  "disabled_without_verified_provider",
			LedgerBackend:      ledgerBackend,
		})
	})
	if webhook != nil {
		mux.Handle("POST /v1/providers/yellowcard/webhooks", webhook)
	}
	mux.HandleFunc("POST /v1/orders/validate", func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		metrics.validationsTotal.Add(1)
		var input validationRequest
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			metrics.validationsInvalid.Add(1)
			http.Error(w, "invalid JSON request", http.StatusBadRequest)
			return
		}
		order, err := domain.NewOrder(input.ID, input.IdempotencyKey, domain.Corridor(input.Corridor), domain.Money{Currency: input.SourceCurrency, Amount: input.SourceAmount}, domain.Money{Currency: input.TargetCurrency, Amount: input.TargetAmount}, now())
		if err != nil {
			metrics.validationsInvalid.Add(1)
			http.Error(w, err.Error(), http.StatusUnprocessableEntity)
			return
		}
		if input.PolicyOutcome != "" || input.PolicyVersion != "" {
			if err := order.ApplyPolicy(domain.PolicyDecision{Outcome: input.PolicyOutcome, Version: input.PolicyVersion}); err != nil {
				metrics.validationsInvalid.Add(1)
				http.Error(w, err.Error(), http.StatusUnprocessableEntity)
				return
			}
		}

		correlationID := input.CorrelationID
		if correlationID == "" {
			generated, err := randomID()
			if err != nil {
				metrics.validationsFailed.Add(1)
				http.Error(w, "could not derive a correlation id", http.StatusInternalServerError)
				return
			}
			correlationID = generated
		}
		eventID, err := randomID()
		if err != nil {
			metrics.validationsFailed.Add(1)
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
			metrics.validationsFailed.Add(1)
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(envelope)
	})
	return mux
}

func main() {
	ledgerRuntime, err := ledger.RuntimeFromProcessEnv()
	if err != nil {
		panic(err)
	}
	defer ledgerRuntime.Close()
	webhookRuntime, err := provider.WebhookRuntimeFromEnvironment(os.Getenv)
	if err != nil {
		panic(err)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8081"
	}
	if err := http.ListenAndServe(":"+port, newHandlerWithWebhook(time.Now, webhookRuntime, ledgerRuntime.Backend)); err != nil {
		panic(err)
	}
}
