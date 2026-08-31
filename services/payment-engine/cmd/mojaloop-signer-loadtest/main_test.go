package main

import (
	"context"
	"testing"
	"time"
)

func TestRunLoadTestSuccessAndMetrics(t *testing.T) {
	report, err := runLoadTest(context.Background(), loadConfig{Workers: 2, Calls: 20, MaxAttempts: 2, Latency: time.Microsecond, SpikeLatency: time.Microsecond, InitialBackoff: 0, MaxBackoff: time.Microsecond, SpikeEvery: 0, FailureEvery: 0}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if report.Successful != 20 || report.Failed != 0 || report.SignerAttemptsTotal != 20 {
		t.Fatalf("unexpected report: %+v", report)
	}
}

func TestRunLoadTestCountsExhaustedTransientFailures(t *testing.T) {
	report, err := runLoadTest(context.Background(), loadConfig{Workers: 2, Calls: 20, MaxAttempts: 1, Latency: time.Microsecond, SpikeLatency: time.Microsecond, InitialBackoff: 0, MaxBackoff: time.Microsecond, SpikeEvery: 0, FailureEvery: 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if report.Successful != 0 || report.Failed != 20 || report.RetryExhaustedTotal == 0 {
		t.Fatalf("expected exhausted failures: %+v", report)
	}
}

func TestRunLoadTestRejectsInvalidConfig(t *testing.T) {
	_, err := runLoadTest(context.Background(), loadConfig{Workers: 0, Calls: 1, MaxAttempts: 1, Latency: time.Millisecond, SpikeLatency: time.Millisecond}, nil)
	if err == nil {
		t.Fatal("expected invalid configuration error")
	}
}
