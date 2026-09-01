package attestation

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type simulatedFabricCommitter struct {
	mu        sync.Mutex
	committed map[string]struct{}
	latency   time.Duration
}

func newSimulatedFabricCommitter(latency time.Duration) *simulatedFabricCommitter {
	return &simulatedFabricCommitter{committed: make(map[string]struct{}), latency: latency}
}

func (f *simulatedFabricCommitter) submit(ctx context.Context, key string) error {
	timer := time.NewTimer(f.latency)
	select {
	case <-ctx.Done():
		timer.Stop()
		return ctx.Err()
	case <-timer.C:
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, exists := f.committed[key]; exists {
		return errors.New("MVCC_READ_CONFLICT: attestation key already committed")
	}
	f.committed[key] = struct{}{}
	return nil
}

func TestFabricCommitLatencyAndMVCCConflictSimulation100Concurrent(t *testing.T) {
	const workers = 100
	const commitLatency = 5 * time.Millisecond
	fabric := newSimulatedFabricCommitter(commitLatency)
	var successes atomic.Int32
	var conflicts atomic.Int32
	var otherErrors atomic.Int32
	latencies := make(chan time.Duration, workers)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			begin := time.Now()
			err := fabric.submit(context.Background(), "deterministic-attestation-key")
			latencies <- time.Since(begin)
			switch {
			case err == nil:
				successes.Add(1)
			case err != nil && strings.HasPrefix(err.Error(), "MVCC_"):
				conflicts.Add(1)
			default:
				otherErrors.Add(1)
			}
		}()
	}
	close(start)
	wg.Wait()
	close(latencies)
	var total time.Duration
	var count int
	for latency := range latencies {
		total += latency
		count++
	}
	if successes.Load() != 1 || conflicts.Load() != workers-1 || otherErrors.Load() != 0 {
		t.Fatalf("successes=%d conflicts=%d other_errors=%d", successes.Load(), conflicts.Load(), otherErrors.Load())
	}
	avg := total / time.Duration(count)
	t.Logf("SIMULATED fabric workers=%d commit_latency=%s successes=%d mvcc_conflicts=%d conflict_rate=%.2f%% avg_observed_latency=%s", workers, commitLatency, successes.Load(), conflicts.Load(), float64(conflicts.Load())/workers*100, avg)
}

func BenchmarkFabricCommitLatencySimulation100Concurrent(b *testing.B) {
	const workers = 100
	fabric := newSimulatedFabricCommitter(5 * time.Millisecond)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		start := make(chan struct{})
		var wg sync.WaitGroup
		var success atomic.Int32
		for worker := 0; worker < workers; worker++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				if fabric.submit(context.Background(), fmt.Sprintf("benchmark-%d", i)) == nil {
					success.Add(1)
				}
			}()
		}
		close(start)
		wg.Wait()
		if success.Load() != 1 {
			b.Fatalf("expected one successful commit, got %d", success.Load())
		}
	}
}
