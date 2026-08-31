package provider

import (
	"context"
	"errors"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

type retryTestSigner struct {
	calls atomic.Int32
	fail  int32
	err   error
}

func (s *retryTestSigner) SignFSPIOP(context.Context, string, string, []byte) (string, error) {
	call := s.calls.Add(1)
	if call <= s.fail {
		return "", s.err
	}
	return "signed", nil
}

type temporarySignerError struct{}

func (temporarySignerError) Error() string   { return "temporary signer outage" }
func (temporarySignerError) Timeout() bool   { return true }
func (temporarySignerError) Temporary() bool { return true }

func TestRetryingMojaloopSignerRetriesTransientFailuresAndRecordsMetrics(t *testing.T) {
	base := &retryTestSigner{fail: 2, err: temporarySignerError{}}
	metrics := &SignerRetryMetrics{}
	var delays []time.Duration
	signer, err := NewRetryingMojaloopSigner(base, SignerRetryPolicy{
		MaxAttempts:  3,
		InitialDelay: time.Millisecond,
		MaxDelay:     2 * time.Millisecond,
		Sleep: func(_ context.Context, delay time.Duration) error {
			delays = append(delays, delay)
			return nil
		},
	}, metrics)
	if err != nil {
		t.Fatal(err)
	}
	got, err := signer.SignFSPIOP(context.Background(), "GET", "/transfers/id", nil)
	if err != nil || got != "signed" {
		t.Fatalf("signature=%q err=%v", got, err)
	}
	if base.calls.Load() != 3 || len(delays) != 2 || delays[0] != time.Millisecond || delays[1] != 2*time.Millisecond {
		t.Fatalf("calls=%d delays=%v", base.calls.Load(), delays)
	}
	snapshot := metrics.Snapshot()
	if snapshot.AttemptsTotal != 3 || snapshot.RetriesTotal != 2 || snapshot.RetryExhaustedTotal != 0 {
		t.Fatalf("metrics=%+v", snapshot)
	}
}

func TestRetryingMojaloopSignerStopsAtBoundedExhaustion(t *testing.T) {
	base := &retryTestSigner{fail: 10, err: temporarySignerError{}}
	metrics := &SignerRetryMetrics{}
	signer, err := NewRetryingMojaloopSigner(base, SignerRetryPolicy{
		MaxAttempts:  3,
		InitialDelay: time.Nanosecond,
		MaxDelay:     time.Nanosecond,
		Sleep:        func(context.Context, time.Duration) error { return nil },
	}, metrics)
	if err != nil {
		t.Fatal(err)
	}
	_, err = signer.SignFSPIOP(context.Background(), "POST", "/transfers", []byte("body"))
	if err == nil || base.calls.Load() != 3 {
		t.Fatalf("err=%v calls=%d", err, base.calls.Load())
	}
	if snapshot := metrics.Snapshot(); snapshot.RetryExhaustedTotal != 1 || snapshot.RetriesTotal != 2 {
		t.Fatalf("metrics=%+v", snapshot)
	}
}

func TestRetryingMojaloopSignerDoesNotRetryNonRetryableErrors(t *testing.T) {
	base := &retryTestSigner{fail: 3, err: errors.New("invalid key reference")}
	metrics := &SignerRetryMetrics{}
	signer, err := NewRetryingMojaloopSigner(base, SignerRetryPolicy{MaxAttempts: 5, Sleep: func(context.Context, time.Duration) error { t.Fatal("unexpected sleep"); return nil }}, metrics)
	if err != nil {
		t.Fatal(err)
	}
	_, err = signer.SignFSPIOP(context.Background(), "GET", "/transfers/id", nil)
	if err == nil || base.calls.Load() != 1 {
		t.Fatalf("err=%v calls=%d", err, base.calls.Load())
	}
	if snapshot := metrics.Snapshot(); snapshot.NonRetryableErrorsTotal != 1 || snapshot.RetriesTotal != 0 {
		t.Fatalf("metrics=%+v", snapshot)
	}
}

func TestRetryingMojaloopSignerHonorsContextCancellationDuringBackoff(t *testing.T) {
	base := &retryTestSigner{fail: 10, err: temporarySignerError{}}
	ctx, cancel := context.WithCancel(context.Background())
	metrics := &SignerRetryMetrics{}
	signer, err := NewRetryingMojaloopSigner(base, SignerRetryPolicy{
		MaxAttempts:  4,
		InitialDelay: time.Hour,
		MaxDelay:     time.Hour,
	}, metrics)
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() {
		_, callErr := signer.SignFSPIOP(ctx, "GET", "/transfers/id", nil)
		finished <- callErr
	}()
	for base.calls.Load() == 0 {
		time.Sleep(time.Millisecond)
	}
	cancel()
	select {
	case callErr := <-finished:
		if !errors.Is(callErr, context.Canceled) {
			t.Fatalf("err=%v, want context.Canceled", callErr)
		}
	case <-time.After(time.Second):
		t.Fatal("signer did not honor context cancellation")
	}
	if base.calls.Load() != 1 {
		t.Fatalf("calls=%d, want 1", base.calls.Load())
	}
}

func TestRetryingMojaloopSignerRetriesNetTimeout(t *testing.T) {
	base := &retryTestSigner{fail: 1, err: &net.DNSError{IsTimeout: true}}
	signer, err := NewRetryingMojaloopSigner(base, SignerRetryPolicy{MaxAttempts: 2, InitialDelay: time.Nanosecond, MaxDelay: time.Nanosecond, Sleep: func(context.Context, time.Duration) error { return nil }}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := signer.SignFSPIOP(context.Background(), "GET", "/transfers/id", nil); err != nil {
		t.Fatal(err)
	}
}
