package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/provider"
)

type transientError struct{}

func (transientError) Error() string   { return "synthetic HSM transient outage" }
func (transientError) Timeout() bool   { return true }
func (transientError) Temporary() bool { return true }

var _ net.Error = transientError{}

type syntheticSigner struct {
	calls        atomic.Uint64
	failureEvery uint64
	spikeEvery   uint64
	latency      time.Duration
	spikeLatency time.Duration
}

func (s *syntheticSigner) SignFSPIOP(ctx context.Context, _ string, _ string, _ []byte) (string, error) {
	call := s.calls.Add(1)
	delay := s.latency
	if s.spikeEvery > 0 && call%s.spikeEvery == 0 {
		delay = s.spikeLatency
	}
	timer := time.NewTimer(delay)
	select {
	case <-timer.C:
	case <-ctx.Done():
		timer.Stop()
		return "", ctx.Err()
	}
	if s.failureEvery > 0 && call%s.failureEvery == 0 {
		return "", transientError{}
	}
	return fmt.Sprintf("synthetic-signature-%d", call), nil
}

type loadReport struct {
	Workers                 int     `json:"workers"`
	Calls                   int     `json:"calls"`
	Successful              uint64  `json:"successful"`
	Failed                  uint64  `json:"failed"`
	ElapsedMilliseconds     float64 `json:"elapsed_milliseconds"`
	P50Milliseconds         float64 `json:"p50_milliseconds"`
	P95Milliseconds         float64 `json:"p95_milliseconds"`
	P99Milliseconds         float64 `json:"p99_milliseconds"`
	SignerAttemptsTotal     uint64  `json:"signer_attempts_total"`
	SignerRetriesTotal      uint64  `json:"signer_retries_total"`
	RetryExhaustedTotal     uint64  `json:"signer_retry_exhausted_total"`
	NonRetryableErrorsTotal uint64  `json:"signer_non_retryable_errors_total"`
}

func percentile(values []float64, p float64) float64 {
	if len(values) == 0 {
		return 0
	}
	index := int(float64(len(values)-1) * p)
	return values[index]
}

func main() {
	workers := flag.Int("workers", 32, "concurrent synthetic signer callers")
	calls := flag.Int("calls", 1000, "total signing calls")
	latency := flag.Duration("latency", 5*time.Millisecond, "normal HSM latency")
	spikeLatency := flag.Duration("spike-latency", 250*time.Millisecond, "synthetic latency spike")
	spikeEvery := flag.Uint64("spike-every", 17, "inject a spike every N underlying signer calls; zero disables spikes")
	failureEvery := flag.Uint64("failure-every", 11, "return a transient signer error every N underlying calls; zero disables failures")
	maxAttempts := flag.Int("max-attempts", 3, "maximum signer attempts including the initial attempt")
	initialBackoff := flag.Duration("initial-backoff", time.Millisecond, "initial retry backoff")
	maxBackoff := flag.Duration("max-backoff", 10*time.Millisecond, "maximum retry backoff")
	flag.Parse()
	if *workers < 1 || *calls < 1 || *maxAttempts < 1 {
		panic("workers, calls, and max-attempts must be positive")
	}

	base := &syntheticSigner{latency: *latency, spikeLatency: *spikeLatency, spikeEvery: *spikeEvery, failureEvery: *failureEvery}
	metrics := &provider.SignerRetryMetrics{}
	signer, err := provider.NewRetryingMojaloopSigner(base, provider.SignerRetryPolicy{
		MaxAttempts: *maxAttempts, InitialDelay: *initialBackoff, MaxDelay: *maxBackoff,
	}, metrics)
	if err != nil {
		panic(err)
	}

	latencies := make([]float64, 0, *calls)
	var latencyMu sync.Mutex
	var successful, failed atomic.Uint64
	var next atomic.Int64
	started := time.Now()
	var wg sync.WaitGroup
	for worker := 0; worker < *workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				index := int(next.Add(1))
				if index > *calls {
					return
				}
				callStart := time.Now()
				_, callErr := signer.SignFSPIOP(context.Background(), "GET", "/transfers/synthetic", nil)
				elapsed := float64(time.Since(callStart).Microseconds()) / 1000
				latencyMu.Lock()
				latencies = append(latencies, elapsed)
				latencyMu.Unlock()
				if callErr != nil {
					failed.Add(1)
				} else {
					successful.Add(1)
				}
			}
		}()
	}
	wg.Wait()
	sort.Float64s(latencies)
	snapshot := metrics.Snapshot()
	report := loadReport{
		Workers: *workers, Calls: *calls, Successful: successful.Load(), Failed: failed.Load(),
		ElapsedMilliseconds: float64(time.Since(started).Microseconds()) / 1000,
		P50Milliseconds:     percentile(latencies, 0.50), P95Milliseconds: percentile(latencies, 0.95), P99Milliseconds: percentile(latencies, 0.99),
		SignerAttemptsTotal: snapshot.AttemptsTotal, SignerRetriesTotal: snapshot.RetriesTotal,
		RetryExhaustedTotal: snapshot.RetryExhaustedTotal, NonRetryableErrorsTotal: snapshot.NonRetryableErrorsTotal,
	}
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		panic(err)
	}
	fmt.Println(string(encoded))
}
