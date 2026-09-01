package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "github.com/lib/pq"
	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/attestation"
)

func positiveInt(getenv func(string) string, key string, fallback int) (int, error) {
	value := strings.TrimSpace(getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return parsed, nil
}

func durationEnv(getenv func(string) string, key string, fallback time.Duration) (time.Duration, error) {
	value := strings.TrimSpace(getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration", key)
	}
	return parsed, nil
}

func openQueueDB(ctx context.Context, getenv func(string) string) (*sql.DB, error) {
	dsn := strings.TrimSpace(getenv("UMOJA_FABRIC_QUEUE_DATABASE_URL"))
	if dsn == "" {
		return nil, errors.New("UMOJA_FABRIC_QUEUE_DATABASE_URL is required for fabric-attestation-worker")
	}
	maxOpen, err := positiveInt(getenv, "UMOJA_POSTGRES_MAX_OPEN_CONNS", 16)
	if err != nil {
		return nil, err
	}
	maxIdle, err := positiveInt(getenv, "UMOJA_POSTGRES_MAX_IDLE_CONNS", 8)
	if err != nil {
		return nil, err
	}
	if maxIdle > maxOpen {
		return nil, errors.New("UMOJA_POSTGRES_MAX_IDLE_CONNS cannot exceed UMOJA_POSTGRES_MAX_OPEN_CONNS")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		return nil, fmt.Errorf("open queue PostgreSQL: %w", err)
	}
	db.SetMaxOpenConns(maxOpen)
	db.SetMaxIdleConns(maxIdle)
	if raw := strings.TrimSpace(getenv("UMOJA_POSTGRES_CONN_MAX_LIFETIME")); raw != "" {
		lifetime, parseErr := time.ParseDuration(raw)
		if parseErr != nil || lifetime <= 0 {
			_ = db.Close()
			return nil, fmt.Errorf("UMOJA_POSTGRES_CONN_MAX_LIFETIME must be positive: %w", parseErr)
		}
		db.SetConnMaxLifetime(lifetime)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := db.PingContext(pingCtx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("queue PostgreSQL readiness: %w", err)
	}
	return db, nil
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	getenv := os.Getenv
	stat := func(path string) error { _, statErr := os.Stat(path); return statErr }
	runtimeConfig, err := attestation.LoadRuntimeConfig(getenv, stat)
	if err != nil || !runtimeConfig.Enabled {
		panic(fmt.Errorf("Fabric worker configuration invalid: %w", err))
	}
	gateway, err := attestation.NewGatewayClient(runtimeConfig.GatewayConfig)
	if err != nil {
		panic(err)
	}
	defer gateway.Close()
	db, err := openQueueDB(ctx, getenv)
	if err != nil {
		panic(err)
	}
	defer db.Close()
	metrics := attestation.NewMetrics()
	metrics.SetResourceLabels(getenv("POD_NAMESPACE"), getenv("POD_NAME"))
	refreshInterval, err := durationEnv(getenv, "UMOJA_FABRIC_QUEUE_METRICS_REFRESH_INTERVAL", 5*time.Second)
	if err != nil {
		panic(err)
	}
	if err := attestation.StartQueueDepthRefresher(ctx, db, metrics, refreshInterval); err != nil {
		panic(err)
	}
	admissionLimit, err := positiveInt(getenv, "UMOJA_FABRIC_ADMISSION_LIMIT", 4)
	if err != nil {
		panic(err)
	}
	admission, err := attestation.NewAdmissionController(admissionLimit)
	if err != nil {
		panic(err)
	}
	admission.SetMetrics(metrics)
	leaseDuration, err := durationEnv(getenv, "UMOJA_FABRIC_QUEUE_LEASE_DURATION", 90*time.Second)
	if err != nil {
		panic(err)
	}
	pollInterval, err := durationEnv(getenv, "UMOJA_FABRIC_QUEUE_POLL_INTERVAL", 250*time.Millisecond)
	if err != nil {
		panic(err)
	}
	retryDelay, err := durationEnv(getenv, "UMOJA_FABRIC_QUEUE_RETRY_DELAY", 30*time.Second)
	if err != nil {
		panic(err)
	}
	queue := &attestation.PostgreSQLQueue{DB: db, LeaseDuration: leaseDuration, Metrics: metrics}
	storageEndpoint := getenvDefault(getenv, "UMOJA_OBJECT_STORAGE_ENDPOINT", getenvDefault(getenv, "UMOJA_STORAGE_ENDPOINT", ""))
	storageBucket := getenvDefault(getenv, "UMOJA_OBJECT_STORAGE_BUCKET", getenvDefault(getenv, "UMOJA_STORAGE_BUCKET", ""))
	storageAccessKey := getenvDefault(getenv, "UMOJA_OBJECT_STORAGE_ACCESS_KEY_ID", getenvDefault(getenv, "UMOJA_STORAGE_ACCESS_KEY", ""))
	storageSecretKey := getenvDefault(getenv, "UMOJA_OBJECT_STORAGE_SECRET_ACCESS_KEY", getenvDefault(getenv, "UMOJA_STORAGE_SECRET_KEY", ""))
	storageRegion := getenvDefault(getenv, "UMOJA_OBJECT_STORAGE_REGION", "us-east-1")
	useSSL := !strings.EqualFold(strings.TrimSpace(getenv("UMOJA_OBJECT_STORAGE_USE_SSL")), "false")
	var evidenceLoader attestation.EvidenceLoader
	vaultAddress := strings.TrimSpace(getenv("UMOJA_VAULT_ADDR"))
	if vaultAddress != "" {
		provider := &attestation.VaultKV2CredentialProvider{HTTPClient: &http.Client{Timeout: 5 * time.Second}, Address: vaultAddress, Token: getenv("UMOJA_VAULT_TOKEN"), TokenFile: getenv("UMOJA_VAULT_TOKEN_FILE"), SecretPath: getenv("UMOJA_VAULT_OBJECT_STORAGE_SECRET_PATH"), Namespace: getenv("UMOJA_VAULT_NAMESPACE")}
		evidenceLoader, err = attestation.NewVersionAwareObjectStorageEvidenceLoader(provider, storageEndpoint, storageBucket, storageRegion, getenv("UMOJA_OBJECT_STORAGE_CANARY_KEY"), useSSL)
	} else {
		staticLoader, staticErr := attestation.NewObjectStorageEvidenceLoader(storageEndpoint, storageAccessKey, storageSecretKey, storageRegion, storageBucket, useSSL)
		evidenceLoader, err = staticLoader, staticErr
	}
	if err != nil {
		panic(err)
	}
	manifestGate, err := attestation.NewReleaseManifestGate(getenv("UMOJA_RELEASE_MANIFEST_PATH"), getenv("UMOJA_RELEASE_SIGNATURES_DIR"), getenvDefault(getenv, "UMOJA_ENV", "staging"))
	if err != nil {
		panic(err)
	}
	worker := &attestation.Worker{Queue: queue, Attestor: mustClient(gateway), Evidence: evidenceLoader, ManifestGate: manifestGate, Admission: admission, PollInterval: pollInterval, RetryDelay: retryDelay, Now: time.Now, Logger: log.Default()}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		metrics.WritePrometheus(w)
	})
	server := &http.Server{Addr: ":" + getenvDefault(getenv, "PORT", "8081"), Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if serveErr := server.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			log.Printf("worker metrics server stopped: %v", serveErr)
		}
	}()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	if err := worker.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		panic(err)
	}
}

func mustClient(gateway *attestation.GatewayClient) *attestation.Client {
	client, err := attestation.NewClient(gateway)
	if err != nil {
		panic(err)
	}
	return client
}

func getenvDefault(getenv func(string) string, key, fallback string) string {
	if value := strings.TrimSpace(getenv(key)); value != "" {
		return value
	}
	return fallback
}
