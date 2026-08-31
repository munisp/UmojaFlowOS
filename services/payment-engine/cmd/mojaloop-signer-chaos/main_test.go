package main

import (
	"context"
	"testing"
	"time"
)

func TestRunChaosReportsExhaustionWithoutUnexpectedOutcomes(t *testing.T) {
	report, err := runChaos(context.Background(), chaosConfig{Nodes: 2, Calls: 3, Workers: 2, MaxAttempts: 1, Latency: time.Microsecond, SpikeLatency: time.Microsecond, FailAfter: 0, CallTimeout: 20 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	if report.Successful+report.Exhausted != 12 || report.Exhausted == 0 || report.Unexpected != 0 {
		t.Fatalf("unexpected report: %+v", report)
	}
}

func TestChaosHSMHonorsContextCancellation(t *testing.T) {
	hsm := &chaosHSM{startedAt: time.Now(), failAfter: time.Hour, latency: time.Second, spikeLatency: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := hsm.SignFSPIOP(ctx, "GET", "/transfers/synthetic", nil); err != context.Canceled {
		t.Fatalf("error=%v, want context.Canceled", err)
	}
}

func TestRunChaosRejectsInvalidConfig(t *testing.T) {
	_, err := runChaos(context.Background(), chaosConfig{Nodes: 0, Calls: 1, Workers: 1, MaxAttempts: 1, Latency: time.Millisecond, SpikeLatency: time.Millisecond, CallTimeout: time.Millisecond})
	if err == nil {
		t.Fatal("expected invalid configuration error")
	}
}
