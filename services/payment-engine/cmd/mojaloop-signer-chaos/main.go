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
	startedAt    time.Time
	failAfter    time.Duration
	latency      time.Duration
	spikeLatency time.Duration
	calls        atomic.Uint64
}

func (h *chaosHSM) SignFSPIOP(ctx context.Context, method, requestURI string, body []byte) (string, error) {
	h.calls.Add(1)
	latency := h.latency
	if h.failAfter > 0 && time.Since(h.startedAt) >= h.failAfter {
		latency = h.spikeLatency
	}
	timer := time.NewTimer(latency)
	select {
	case <-timer.C:
	case <-ctx.Done():
		timer.Stop()
		return "", ctx.Err()
	}
	if h.failAfter == 0 || time.Since(h.startedAt) >= h.failAfter {
		return "", transientHSMError{}
	}
	return "synthetic-signature", nil
}

func main() {
	nodes := flag.Int("nodes", 8, "number of synthetic payment-engine nodes")
	calls := flag.Int("calls", 64, "signing calls per node")
	workers := flag.Int("workers", 8, "concurrent workers per node")
	latency := flag.Duration("latency", 2*time.Millisecond, "normal synthetic HSM latency")
	spikeLatency := flag.Duration("spike-latency", 20*time.Millisecond, "latency during the cascading failure")
	failAfter := flag.Duration("fail-after", 25*time.Millisecond, "time before each node enters transient-failure mode")
	maxAttempts := flag.Int("max-attempts", 3, "maximum attempts per signing call")
	callTimeout := flag.Duration("call-timeout", 200*time.Millisecond, "per-signing-call deadline")
	flag.Parse()

	if *nodes < 1 || *calls < 1 || *workers < 1 || *maxAttempts < 1 || *latency <= 0 || *spikeLatency <= 0 || *callTimeout <= 0 {
		panic("all counts must be positive and all durations must be greater than zero")
	}

	var successful atomic.Uint64
	var exhausted atomic.Uint64
	var unexpected atomic.Uint64
	var wg sync.WaitGroup
	start := time.Now()

	for node := 0; node < *nodes; node++ {
		hsm := &chaosHSM{
			startedAt:    start,
			failAfter:    *failAfter + time.Duration(node)*5*time.Millisecond,
			latency:      *latency,
			spikeLatency: *spikeLatency,
		}
		signer, err := provider.NewRetryingMojaloopSigner(hsm, provider.SignerRetryPolicy{
			MaxAttempts:  *maxAttempts,
			InitialDelay: 1 * time.Millisecond,
			MaxDelay:     4 * time.Millisecond,
		}, nil)
		if err != nil {
			panic(err)
		}
		for worker := 0; worker < *workers; worker++ {
			wg.Add(1)
			go func(signer *provider.RetryingMojaloopSigner) {
				defer wg.Done()
				for i := 0; i < *calls; i++ {
					ctx, cancel := context.WithTimeout(context.Background(), *callTimeout)
					_, err := signer.SignFSPIOP(ctx, "GET", "/transfers/synthetic", []byte("synthetic"))
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

	fmt.Printf("nodes=%d calls=%d workers=%d successful=%d exhausted=%d unexpected=%d elapsed=%s\n", *nodes, *calls, *workers, successful.Load(), exhausted.Load(), unexpected.Load(), time.Since(start).Round(time.Millisecond))
	totalCalls := uint64(*nodes * *calls * *workers)
	if unexpected.Load() != 0 || successful.Load()+exhausted.Load() != totalCalls || exhausted.Load() == 0 {
		panic("chaos invariant failed: cascading signer outage produced an unexpected signer outcome")
	}
}
