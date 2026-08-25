package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/ledger"
)

type config struct {
	address      string
	clusterID    uint32
	ledgerID     uint32
	accountCode  uint16
	transferCode uint16
	debitID      uint64
	creditID     uint64
	batchSize    int
	workers      int
	duration     time.Duration
}

type report struct {
	Status          string  `json:"status"`
	Batches         uint64  `json:"batches"`
	Transfers       uint64  `json:"transfers"`
	Failures        uint64  `json:"failures"`
	ElapsedSeconds  float64 `json:"elapsed_seconds"`
	TransfersPerSec float64 `json:"transfers_per_second"`
	P50Millis       float64 `json:"p50_ms"`
	P95Millis       float64 `json:"p95_ms"`
	P99Millis       float64 `json:"p99_ms"`
}

func main() {
	if os.Getenv("TIGERBEETLE_LOADTEST_APPROVED") != "STAGING_ONLY_APPROVED" ||
		os.Getenv("TIGERBEETLE_LOADTEST_TARGET") != "staging" {
		fatal(errors.New("refusing load test: require TIGERBEETLE_LOADTEST_APPROVED=STAGING_ONLY_APPROVED and TIGERBEETLE_LOADTEST_TARGET=staging"))
	}
	cfg, err := readConfig()
	if err != nil {
		fatal(err)
	}
	client, err := ledger.NewTigerBeetleClient(ledger.ClusterConfig{
		Addresses:             []string{cfg.address},
		ClusterID:             cfg.clusterID,
		TLSRequired:           os.Getenv("TIGERBEETLE_LOADTEST_TLS_REQUIRED") != "false",
		AllowInsecureLoopback: os.Getenv("TIGERBEETLE_LOADTEST_ALLOW_INSECURE_LOOPBACK") == "true",
		CurrencyLedgers:       map[string]uint32{"NGN": cfg.ledgerID},
		AccountCode:           cfg.accountCode,
		TransferCode:          cfg.transferCode,
	})
	if err != nil {
		fatal(fmt.Errorf("create staging TigerBeetle client: %w", err))
	}
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), cfg.duration+30*time.Second)
	defer cancel()
	started := time.Now()
	var batches atomic.Uint64
	var transfers atomic.Uint64
	var failures atomic.Uint64
	latencies := make(chan time.Duration, cfg.workers*64)
	var wg sync.WaitGroup
	for worker := 0; worker < cfg.workers; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			sequence := uint64(worker) << 48
			for time.Since(started) < cfg.duration {
				batch := make([]ledger.Transfer, cfg.batchSize)
				for index := range batch {
					sequence++
					batch[index] = ledger.Transfer{
						ID:              uint64(time.Now().UnixNano()) + sequence,
						DebitAccountID:  cfg.debitID,
						CreditAccountID: cfg.creditID,
						Amount:          1,
						Currency:        "NGN",
					}
				}
				callStarted := time.Now()
				err := client.CreateTransfers(ctx, batch)
				latencies <- time.Since(callStarted)
				if err != nil {
					failures.Add(1)
					continue
				}
				batches.Add(1)
				transfers.Add(uint64(len(batch)))
			}
		}(worker)
	}
	wg.Wait()
	close(latencies)
	values := make([]float64, 0, cap(latencies))
	for latency := range latencies {
		values = append(values, float64(latency.Microseconds())/1000)
	}
	result := report{
		Status:         "passed",
		Batches:        batches.Load(),
		Transfers:      transfers.Load(),
		Failures:       failures.Load(),
		ElapsedSeconds: time.Since(started).Seconds(),
	}
	if result.ElapsedSeconds > 0 {
		result.TransfersPerSec = float64(result.Transfers) / result.ElapsedSeconds
	}
	if len(values) > 0 {
		sortFloats(values)
		result.P50Millis = percentile(values, 0.50)
		result.P95Millis = percentile(values, 0.95)
		result.P99Millis = percentile(values, 0.99)
	}
	if result.Failures > 0 || result.Transfers == 0 {
		result.Status = "failed"
	}
	if path := strings.TrimSpace(os.Getenv("TIGERBEETLE_LOADTEST_METRICS_PATH")); path != "" {
		if err := writeMetrics(path, result); err != nil {
			fatal(fmt.Errorf("write load-test metrics: %w", err))
		}
	}
	encoded, _ := json.Marshal(result)
	fmt.Println(string(encoded))
	if result.Status != "passed" {
		os.Exit(1)
	}
}

func readConfig() (config, error) {
	address := strings.TrimSpace(os.Getenv("TIGERBEETLE_LOADTEST_ADDRESS"))
	if address == "" {
		return config{}, errors.New("TIGERBEETLE_LOADTEST_ADDRESS is required")
	}
	clusterID, err := requiredUint32("TIGERBEETLE_LOADTEST_CLUSTER_ID")
	if err != nil {
		return config{}, err
	}
	ledgerID, err := requiredUint32("TIGERBEETLE_LOADTEST_NGN_LEDGER")
	if err != nil {
		return config{}, err
	}
	accountCode, err := requiredUint16("TIGERBEETLE_LOADTEST_ACCOUNT_CODE")
	if err != nil {
		return config{}, err
	}
	transferCode, err := requiredUint16("TIGERBEETLE_LOADTEST_TRANSFER_CODE")
	if err != nil {
		return config{}, err
	}
	debitID, err := requiredUint64("TIGERBEETLE_LOADTEST_DEBIT_ACCOUNT_ID")
	if err != nil {
		return config{}, err
	}
	creditID, err := requiredUint64("TIGERBEETLE_LOADTEST_CREDIT_ACCOUNT_ID")
	if err != nil {
		return config{}, err
	}
	if debitID == creditID {
		return config{}, errors.New("load-test debit and credit accounts must differ")
	}
	batchSize := boundedInt("TIGERBEETLE_LOADTEST_BATCH_SIZE", 256, 1, 8192)
	workers := boundedInt("TIGERBEETLE_LOADTEST_WORKERS", 4, 1, 64)
	seconds := boundedInt("TIGERBEETLE_LOADTEST_DURATION_SECONDS", 60, 1, 300)
	return config{address, clusterID, ledgerID, accountCode, transferCode, debitID, creditID, batchSize, workers, time.Duration(seconds) * time.Second}, nil
}

func requiredUint32(key string) (uint32, error) {
	value := os.Getenv(key)
	n, err := strconv.ParseUint(value, 10, 32)
	if err != nil || n == 0 {
		return 0, fmt.Errorf("%s must be a nonzero uint32", key)
	}
	return uint32(n), nil
}
func requiredUint16(key string) (uint16, error) {
	value := os.Getenv(key)
	n, err := strconv.ParseUint(value, 10, 16)
	if err != nil || n == 0 {
		return 0, fmt.Errorf("%s must be a nonzero uint16", key)
	}
	return uint16(n), nil
}
func requiredUint64(key string) (uint64, error) {
	value := os.Getenv(key)
	n, err := strconv.ParseUint(value, 10, 64)
	if err != nil || n == 0 {
		return 0, fmt.Errorf("%s must be a nonzero uint64", key)
	}
	return n, nil
}
func boundedInt(key string, fallback, min, max int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < min || n > max {
		fatal(fmt.Errorf("%s must be between %d and %d", key, min, max))
	}
	return n
}
func percentile(values []float64, p float64) float64 {
	index := int(float64(len(values)-1) * p)
	return values[index]
}
func sortFloats(values []float64) {
	for i := 1; i < len(values); i++ {
		value := values[i]
		j := i - 1
		for j >= 0 && values[j] > value {
			values[j+1] = values[j]
			j--
		}
		values[j+1] = value
	}
}
func writeMetrics(path string, result report) error {
	if !strings.HasPrefix(path, "/") {
		return errors.New("TIGERBEETLE_LOADTEST_METRICS_PATH must be absolute")
	}
	content := fmt.Sprintf("# TYPE umoja_tigerbeetle_loadtest_requests_total counter\numoja_tigerbeetle_loadtest_requests_total %d\n# TYPE umoja_tigerbeetle_loadtest_failures_total counter\numoja_tigerbeetle_loadtest_failures_total %d\n# TYPE umoja_tigerbeetle_loadtest_transfers_total counter\numoja_tigerbeetle_loadtest_transfers_total %d\n# TYPE umoja_tigerbeetle_loadtest_latency_ms gauge\numoja_tigerbeetle_loadtest_latency_ms{quantile=\"0.50\"} %.3f\numoja_tigerbeetle_loadtest_latency_ms{quantile=\"0.95\"} %.3f\numoja_tigerbeetle_loadtest_latency_ms{quantile=\"0.99\"} %.3f\n# TYPE umoja_tigerbeetle_loadtest_transfers_per_second gauge\numoja_tigerbeetle_loadtest_transfers_per_second %.3f\n", result.Batches, result.Failures, result.Transfers, result.P50Millis, result.P95Millis, result.P99Millis, result.TransfersPerSec)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0640); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func fatal(err error) { fmt.Fprintf(os.Stderr, "loadtest_error=%v\n", err); os.Exit(2) }
