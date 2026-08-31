package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/provider"
)

type transientHSMError struct{}

func (transientHSMError) Error() string   { return "synthetic HSM timeout" }
func (transientHSMError) Timeout() bool   { return true }
func (transientHSMError) Temporary() bool { return true }

var _ net.Error = transientHSMError{}

type chaosHSM struct {
	startedAt                        time.Time
	failAfter, latency, spikeLatency time.Duration
	calls                            atomic.Uint64
}

func (h *chaosHSM) SignFSPIOP(ctx context.Context, _ string, _ string, _ []byte) (string, error) {
	h.calls.Add(1)
	delay := h.latency
	failed := h.failAfter <= 0 || time.Since(h.startedAt) >= h.failAfter
	if failed {
		delay = h.spikeLatency
	}
	timer := time.NewTimer(delay)
	select {
	case <-timer.C:
	case <-ctx.Done():
		timer.Stop()
		return "", ctx.Err()
	}
	if failed {
		return "", transientHSMError{}
	}
	return "synthetic-signature", nil
}

type chaosConfig struct {
	Nodes, Calls, Workers, MaxAttempts            int
	Latency, SpikeLatency, FailAfter, CallTimeout time.Duration
}
type chaosReport struct {
	Nodes      int           `json:"nodes"`
	Calls      int           `json:"calls"`
	Workers    int           `json:"workers"`
	Successful uint64        `json:"successful"`
	Exhausted  uint64        `json:"exhausted"`
	Unexpected uint64        `json:"unexpected"`
	Elapsed    time.Duration `json:"elapsed"`
}

func runChaos(ctx context.Context, cfg chaosConfig) (chaosReport, error) {
	if cfg.Nodes < 1 || cfg.Calls < 1 || cfg.Workers < 1 || cfg.MaxAttempts < 1 || cfg.Latency <= 0 || cfg.SpikeLatency <= 0 || cfg.CallTimeout <= 0 {
		return chaosReport{}, errors.New("all counts must be positive and all durations must be greater than zero")
	}
	var successful, exhausted, unexpected atomic.Uint64
	var wg sync.WaitGroup
	start := time.Now()
	for node := 0; node < cfg.Nodes; node++ {
		hsm := &chaosHSM{startedAt: start, failAfter: cfg.FailAfter + time.Duration(node)*5*time.Millisecond, latency: cfg.Latency, spikeLatency: cfg.SpikeLatency}
		signer, err := provider.NewRetryingMojaloopSigner(hsm, provider.SignerRetryPolicy{MaxAttempts: cfg.MaxAttempts, InitialDelay: time.Millisecond, MaxDelay: 4 * time.Millisecond}, nil)
		if err != nil {
			return chaosReport{}, err
		}
		for worker := 0; worker < cfg.Workers; worker++ {
			wg.Add(1)
			go func(signer *provider.RetryingMojaloopSigner) {
				defer wg.Done()
				for i := 0; i < cfg.Calls; i++ {
					callCtx, cancel := context.WithTimeout(ctx, cfg.CallTimeout)
					_, err := signer.SignFSPIOP(callCtx, "GET", "/transfers/synthetic", []byte("synthetic"))
					cancel()
					switch {
					case err == nil:
						successful.Add(1)
					case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded), errors.As(err, new(net.Error)):
						exhausted.Add(1)
					default:
						unexpected.Add(1)
					}
				}
			}(signer)
		}
	}
	wg.Wait()
	report := chaosReport{Nodes: cfg.Nodes, Calls: cfg.Calls, Workers: cfg.Workers, Successful: successful.Load(), Exhausted: exhausted.Load(), Unexpected: unexpected.Load(), Elapsed: time.Since(start)}
	total := uint64(cfg.Nodes * cfg.Calls * cfg.Workers)
	if report.Unexpected != 0 || report.Successful+report.Exhausted != total || report.Exhausted == 0 {
		return report, errors.New("chaos invariant failed: cascading signer outage produced an unexpected signer outcome")
	}
	return report, nil
}

func main() {
	nodes := flag.Int("nodes", 8, "number of synthetic payment-engine nodes")
	calls := flag.Int("calls", 64, "signing calls per node")
	workers := flag.Int("workers", 8, "concurrent workers per node")
	latency := flag.Duration("latency", 2*time.Millisecond, "normal synthetic HSM latency")
	spikeLatency := flag.Duration("spike-latency", 20*time.Millisecond, "latency during cascading failure")
	failAfter := flag.Duration("fail-after", 25*time.Millisecond, "time before each node enters transient-failure mode")
	maxAttempts := flag.Int("max-attempts", 3, "maximum attempts per signing call")
	callTimeout := flag.Duration("call-timeout", 200*time.Millisecond, "per-signing-call deadline")
	flag.Parse()
	report, err := runChaos(context.Background(), chaosConfig{Nodes: *nodes, Calls: *calls, Workers: *workers, Latency: *latency, SpikeLatency: *spikeLatency, FailAfter: *failAfter, MaxAttempts: *maxAttempts, CallTimeout: *callTimeout})
	if err != nil {
		panic(err)
	}
	fmt.Printf("nodes=%d calls=%d workers=%d successful=%d exhausted=%d unexpected=%d elapsed=%s\n", report.Nodes, report.Calls, report.Workers, report.Successful, report.Exhausted, report.Unexpected, report.Elapsed.Round(time.Millisecond))
}
