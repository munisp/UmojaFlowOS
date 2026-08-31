package multirail

import (
	"context"
	"strconv"
	"sync"
	"testing"
)

type benchmarkRail struct{}

func (benchmarkRail) Name() string { return "benchmark" }
func (benchmarkRail) Submit(context.Context, Intent) (Submission, error) {
	return Submission{ProviderRef: "benchmark-ref", Status: Submitted}, nil
}
func (benchmarkRail) Query(context.Context, Intent) (Submission, error) {
	return Submission{ProviderRef: "benchmark-ref", Status: Submitted}, nil
}

func BenchmarkCoordinatorConcurrentSingleFlight(b *testing.B) {
	coordinator := NewCoordinator()
	rail := benchmarkRail{}
	payload := []byte(`{"amount":100,"currency":"NGN"}`)
	b.ReportAllocs()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			key := "benchmark-key-" + strconv.Itoa(b.N)
			intent := Intent{ID: key, IdempotencyKey: key, Payload: payload}
			if _, err := coordinator.Execute(context.Background(), intent, rail, nil); err != nil {
				b.Errorf("single-flight execution failed: %v", err)
			}
		}
	})
}

func BenchmarkCoordinatorConcurrentDistinctKeys(b *testing.B) {
	coordinator := NewCoordinator()
	rail := benchmarkRail{}
	b.ReportAllocs()
	b.ResetTimer()
	var sequence uint64
	var mu sync.Mutex
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			mu.Lock()
			sequence++
			id := sequence
			mu.Unlock()
			key := "benchmark-distinct-" + strconv.FormatUint(id, 10)
			intent := Intent{ID: key, IdempotencyKey: key, Payload: []byte(`{"amount":100,"currency":"NGN"}`)}
			if _, err := coordinator.Execute(context.Background(), intent, rail, nil); err != nil {
				b.Errorf("distinct-key execution failed: %v", err)
			}
		}
	})
}
