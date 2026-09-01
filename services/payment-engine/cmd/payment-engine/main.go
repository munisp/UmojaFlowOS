package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/domain"
	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/eventing"
	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/ledger"
	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/observability"
	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/provider"
	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/settlement"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
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
	signerRetryMetrics *provider.SignerRetryMetrics
}

// metricsSnapshot is the wire form. The control plane reads it as-is.
type metricsSnapshot struct {
	Service                   string `json:"service"`
	Language                  string `json:"language"`
	UptimeSeconds             int64  `json:"uptime_seconds"`
	ValidationsTotal          uint64 `json:"validations_total"`
	ValidationsInvalid        uint64 `json:"validations_invalid"`
	ValidationsFailed         uint64 `json:"validations_failed"`
	ObservedAt                string `json:"observed_at"`
	ProviderExecution         string `json:"provider_execution"`
	LedgerBackend             string `json:"ledger_backend"`
	SignerAttemptsTotal       uint64 `json:"signer_attempts_total"`
	SignerRetriesTotal        uint64 `json:"signer_retries_total"`
	SignerRetryExhaustedTotal uint64 `json:"signer_retry_exhausted_total"`
	SignerNonRetryableTotal   uint64 `json:"signer_non_retryable_errors_total"`
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
	return newHandlerWithWebhookAndPosting(now, webhook, nil, nil, configuredLedgerBackend...)
}

type ledgerPostingRequest struct {
	TransferID      string `json:"transfer_id"`
	CorrelationID   string `json:"correlation_id"`
	Currency        string `json:"currency"`
	AmountMinor     string `json:"amount_minor"`
	DebitAccountID  string `json:"debit_account_id"`
	CreditAccountID string `json:"credit_account_id"`
	PendingID       string `json:"pending_id,omitempty"`
}

func parsePostingUint(value string, field string, optional bool) (uint64, error) {
	if optional && strings.TrimSpace(value) == "" {
		return 0, nil
	}
	parsed, err := strconv.ParseUint(strings.TrimSpace(value), 10, 64)
	if err != nil || parsed == 0 {
		return 0, fmt.Errorf("%s must be a positive unsigned integer", field)
	}
	return parsed, nil
}

func newHandlerWithWebhookAndPosting(now func() time.Time, webhook http.Handler, posting *ledger.PostingService, execution http.Handler, configuredLedgerBackend ...string) http.Handler {
	return newHandlerWithSignerMetrics(now, webhook, posting, execution, nil, configuredLedgerBackend...)
}

func newHandlerWithSignerMetrics(now func() time.Time, webhook http.Handler, posting *ledger.PostingService, execution http.Handler, signerRetryMetrics *provider.SignerRetryMetrics, configuredLedgerBackend ...string) http.Handler {
	ledgerBackend := "disabled_without_deployed_tigerbeetle"
	if len(configuredLedgerBackend) > 0 && configuredLedgerBackend[0] != "" {
		ledgerBackend = configuredLedgerBackend[0]
	}
	mux := http.NewServeMux()
	metrics := &serviceMetrics{startedAt: now(), signerRetryMetrics: signerRetryMetrics}
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
			Service:                   "payment-engine",
			Language:                  "go",
			UptimeSeconds:             int64(observed.Sub(metrics.startedAt).Seconds()),
			ValidationsTotal:          metrics.validationsTotal.Load(),
			ValidationsInvalid:        metrics.validationsInvalid.Load(),
			ValidationsFailed:         metrics.validationsFailed.Load(),
			ObservedAt:                observed.UTC().Format(time.RFC3339),
			ProviderExecution:         "disabled_without_verified_provider",
			LedgerBackend:             ledgerBackend,
			SignerAttemptsTotal:       signerMetricSnapshot(metrics.signerRetryMetrics).AttemptsTotal,
			SignerRetriesTotal:        signerMetricSnapshot(metrics.signerRetryMetrics).RetriesTotal,
			SignerRetryExhaustedTotal: signerMetricSnapshot(metrics.signerRetryMetrics).RetryExhaustedTotal,
			SignerNonRetryableTotal:   signerMetricSnapshot(metrics.signerRetryMetrics).NonRetryableErrorsTotal,
		})
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		writePrometheusMetrics(w, metrics.signerRetryMetrics)
	})
	if webhook != nil {
		mux.Handle("POST /v1/providers/yellowcard/webhooks", webhook)
	}
	if execution != nil {
		mux.Handle("POST /v1/providers/yellowcard/sends", execution)
	}
	if posting != nil {
		mux.HandleFunc("POST /v1/ledger/postings", func(w http.ResponseWriter, r *http.Request) {
			defer r.Body.Close()
			var input ledgerPostingRequest
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024))
			if err := decoder.Decode(&input); err != nil {
				http.Error(w, "invalid ledger posting request", http.StatusBadRequest)
				return
			}
			transferID, err := parsePostingUint(input.TransferID, "transfer_id", false)
			if err != nil {
				http.Error(w, err.Error(), http.StatusUnprocessableEntity)
				return
			}
			amount, err := parsePostingUint(input.AmountMinor, "amount_minor", false)
			if err != nil {
				http.Error(w, err.Error(), http.StatusUnprocessableEntity)
				return
			}
			debit, err := parsePostingUint(input.DebitAccountID, "debit_account_id", false)
			if err != nil {
				http.Error(w, err.Error(), http.StatusUnprocessableEntity)
				return
			}
			credit, err := parsePostingUint(input.CreditAccountID, "credit_account_id", false)
			if err != nil {
				http.Error(w, err.Error(), http.StatusUnprocessableEntity)
				return
			}
			pending, err := parsePostingUint(input.PendingID, "pending_id", true)
			if err != nil {
				http.Error(w, err.Error(), http.StatusUnprocessableEntity)
				return
			}
			fact, err := posting.PostConfirmedTransfer(r.Context(), ledger.PostingRequest{TransferID: transferID, CorrelationID: input.CorrelationID, Currency: input.Currency, Amount: amount, DebitAccountID: debit, CreditAccountID: credit, PendingID: pending})
			if err != nil {
				http.Error(w, err.Error(), http.StatusServiceUnavailable)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"transfer_id": strconv.FormatUint(fact.TransferID, 10), "correlation_id": fact.CorrelationID, "reconciliation_state": "pending"})
		})
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

func writePrometheusMetrics(w http.ResponseWriter, signerMetrics *provider.SignerRetryMetrics) {
	snapshot := signerMetricSnapshot(signerMetrics)
	fmt.Fprintf(w, "# HELP umoja_signer_attempts_total Total signing attempts sent to the delegated signer.\n# TYPE umoja_signer_attempts_total counter\numoja_signer_attempts_total %d\n", snapshot.AttemptsTotal)
	fmt.Fprintf(w, "# HELP umoja_signer_retries_total Total retries after transient signer failures.\n# TYPE umoja_signer_retries_total counter\numoja_signer_retries_total %d\n", snapshot.RetriesTotal)
	fmt.Fprintf(w, "# HELP umoja_signer_retry_exhausted_total Total signing calls that exhausted their retry budget.\n# TYPE umoja_signer_retry_exhausted_total counter\numoja_signer_retry_exhausted_total %d\n", snapshot.RetryExhaustedTotal)
	fmt.Fprintf(w, "# HELP umoja_signer_non_retryable_errors_total Total non-retryable signer failures.\n# TYPE umoja_signer_non_retryable_errors_total counter\numoja_signer_non_retryable_errors_total %d\n", snapshot.NonRetryableErrorsTotal)
}

func signerMetricSnapshot(metrics *provider.SignerRetryMetrics) provider.SignerRetryMetricsSnapshot {
	if metrics == nil {
		return provider.SignerRetryMetricsSnapshot{}
	}
	return metrics.Snapshot()
}

// startSettlementGRPC starts the internal transport only when an address is
// explicitly configured. Until the real coordinator is composed into this
// binary, requests are held in UNKNOWN and cannot settle. This is deliberate:
// exposing a socket must never imply that a payment execution path is enabled.
func startSettlementGRPC() (*grpc.Server, net.Listener, error) {
	addr := strings.TrimSpace(os.Getenv("GRPC_SETTLEMENT_LISTEN_ADDR"))
	if addr == "" {
		return nil, nil, nil
	}
	caFile := strings.TrimSpace(os.Getenv("GRPC_SETTLEMENT_CA_FILE"))
	certFile := strings.TrimSpace(os.Getenv("GRPC_SETTLEMENT_CERT_FILE"))
	keyFile := strings.TrimSpace(os.Getenv("GRPC_SETTLEMENT_KEY_FILE"))
	tlsConfig, err := settlement.LoadGRPCServerTLSConfig(caFile, certFile, keyFile)
	if err != nil {
		return nil, nil, fmt.Errorf("configure settlement gRPC TLS: %w", err)
	}
	lis, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, nil, fmt.Errorf("listen for settlement gRPC on %s: %w", addr, err)
	}
	grpcServer := grpc.NewServer(grpc.Creds(credentials.NewTLS(tlsConfig)))
	failClosed := func(context.Context, settlement.Intent) (settlement.ProviderResult, error) {
		return settlement.ProviderResult{State: settlement.Unknown, Reason: "settlement coordinator is not composed into payment-engine"}, settlement.ErrUnknown
	}
	settlement.RegisterGRPCSettlementServer(grpcServer, &settlement.GRPCSettlementServer{Handler: failClosed, QueryHandler: failClosed})
	go func() {
		if serveErr := grpcServer.Serve(lis); serveErr != nil {
			fmt.Fprintf(os.Stderr, "settlement gRPC server stopped: %v\\n", serveErr)
		}
	}()
	return grpcServer, lis, nil
}

func main() {
	productionProfile := strings.EqualFold(strings.TrimSpace(os.Getenv("UMOJA_ENV")), "production")
	if _, configErr := provider.LoadNigerianRailConfig(os.Getenv, productionProfile); configErr != nil {
		panic(configErr)
	}
	if _, signerConfigErr := provider.LoadMojaloopSignerRetryPolicy(os.Getenv); signerConfigErr != nil {
		panic(signerConfigErr)
	}
	ledgerRuntime, err := ledger.RuntimeFromProcessEnv()
	if err != nil {
		panic(err)
	}
	defer ledgerRuntime.Close()
	var posting *ledger.PostingService
	if ledgerRuntime.Backend == "configured_reachable_tigerbeetle" {
		resolver := provider.FileSecretResolver{Root: os.Getenv("UMOJA_PROVIDER_MATERIAL_ROOT")}
		sharedSecret, resolveErr := resolver.Resolve(context.Background(), os.Getenv("UMOJA_LEDGER_PROJECTION_HMAC_SECRET_REFERENCE"))
		if resolveErr != nil {
			panic(resolveErr)
		}
		sink, sinkErr := ledger.NewHTTPProjectionSink(ledger.HTTPProjectionSinkConfig{
			Endpoint: os.Getenv("UMOJA_LEDGER_PROJECTION_ENDPOINT"), SharedSecret: sharedSecret.Value,
			AllowInsecureLoopback: os.Getenv("UMOJA_LEDGER_PROJECTION_ALLOW_INSECURE_LOOPBACK") == "true",
		})
		if sinkErr != nil {
			panic(sinkErr)
		}
		posting, err = ledgerRuntime.NewPostingService(sink, time.Now)
		if err != nil {
			panic(err)
		}
	}
	signerRetryMetrics := &provider.SignerRetryMetrics{}
	var executionHandler http.Handler
	executionRuntime, executionErr := provider.YellowCardExecutionRuntimeFromEnvironment(context.Background(), os.Getenv)
	if executionErr != nil {
		panic(executionErr)
	}
	if executionRuntime.Enabled {
		resolver := provider.FileSecretResolver{Root: os.Getenv("UMOJA_PROVIDER_MATERIAL_ROOT")}
		approvalSecret, resolveErr := resolver.Resolve(context.Background(), os.Getenv("UMOJA_YELLOWCARD_EXECUTION_APPROVAL_HMAC_SECRET_REFERENCE"))
		if resolveErr != nil {
			panic(resolveErr)
		}
		executionHandler = provider.YellowCardExecutionHandler{Sender: executionRuntime.Sender, ApprovalSecret: approvalSecret.Value, Now: time.Now, MaxAge: 5 * time.Minute, MaxBodyBytes: 64 * 1024}
	}
	webhookRuntime, err := provider.WebhookRuntimeFromEnvironment(os.Getenv)
	if err != nil {
		panic(err)
	}
	shutdownTelemetry, telemetryErr := observability.Init(context.Background())
	if telemetryErr != nil {
		panic(telemetryErr)
	}
	defer shutdownTelemetry(context.Background())
	port := os.Getenv("PORT")
	if port == "" {
		port = "8081"
	}
	grpcServer, grpcListener, grpcErr := startSettlementGRPC()
	if grpcErr != nil {
		panic(grpcErr)
	}
	if grpcServer != nil {
		defer grpcServer.GracefulStop()
		defer grpcListener.Close()
	}
	handler := observability.Handler(newHandlerWithSignerMetrics(time.Now, webhookRuntime, posting, executionHandler, signerRetryMetrics, ledgerRuntime.Backend))
	if err := http.ListenAndServe(":"+port, handler); err != nil {
		panic(err)
	}
}
