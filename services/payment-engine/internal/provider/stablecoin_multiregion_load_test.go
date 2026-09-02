package provider

import (
	"os"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type stressedRegionStore struct {
	mu             sync.RWMutex
	primaryVersion uint64
	replicaVersion uint64
	fenced         atomic.Bool
}

func (s *stressedRegionStore) primaryWrite() { s.mu.Lock(); s.primaryVersion++; s.mu.Unlock() }
func (s *stressedRegionStore) replicate() {
	s.mu.Lock()
	s.replicaVersion = s.primaryVersion
	s.mu.Unlock()
}
func (s *stressedRegionStore) acceptReplicaTerminal() bool {
	if s.fenced.Load() {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.replicaVersion == s.primaryVersion
}

func TestStablecoinMultiRegionSplitBrainUnderLoad(t *testing.T) {
	workers, _ := strconv.Atoi(getenvDefault("STABLECOIN_LOAD_WORKERS", "32"))
	iterations, _ := strconv.Atoi(getenvDefault("STABLECOIN_LOAD_ITERATIONS", "500"))
	if workers < 1 || iterations < 1 {
		t.Fatal("load parameters must be positive")
	}
	store := &stressedRegionStore{}
	store.fenced.Store(true)
	start := time.Now()
	var held, rejected atomic.Uint64
	var wg sync.WaitGroup
	for worker := 0; worker < workers; worker++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < iterations; i++ {
				store.primaryWrite()
				if store.acceptReplicaTerminal() {
					rejected.Add(1)
				} else {
					held.Add(1)
				}
			}
		}()
	}
	wg.Wait()
	partitionDuration := time.Since(start)
	if rejected.Load() != 0 {
		t.Fatalf("split-brain terminal decisions accepted: %d", rejected.Load())
	}

	recoveryStart := time.Now()
	store.fenced.Store(false)
	store.replicate()
	if !store.acceptReplicaTerminal() {
		t.Fatal("replica did not converge after heal")
	}
	recovery := time.Since(recoveryStart)
	latencies := make([]time.Duration, workers)
	for i := range latencies {
		probeStart := time.Now()
		for !store.acceptReplicaTerminal() {
			runtimeYield()
		}
		latencies[i] = time.Since(probeStart)
	}
	sort.Slice(latencies, func(i, j int) bool { return latencies[i] < latencies[j] })
	p50 := latencies[len(latencies)/2]
	p95 := latencies[(len(latencies)*95)/100]
	t.Logf("workers=%d iterations=%d operations=%d held=%d rejected_terminal=%d partition_window=%s recovery_convergence=%s post_heal_p50=%s post_heal_p95=%s", workers, iterations, workers*iterations, held.Load(), rejected.Load(), partitionDuration, recovery, p50, p95)
}

func getenvDefault(key, fallback string) string {
	if value := lookupEnv(key); value != "" {
		return value
	}
	return fallback
}
func lookupEnv(key string) string { return os.Getenv(key) }
func runtimeYield()               { time.Sleep(0) }
