package provider

import (
	"context"
	"errors"
	"net"
	"sync/atomic"
	"time"
)

// SignerRetryPolicy bounds retries around a delegated HSM/signing service.
// MaxAttempts includes the initial signing attempt.
type SignerRetryPolicy struct {
	MaxAttempts  int
	InitialDelay time.Duration
	MaxDelay     time.Duration
	Sleep        func(context.Context, time.Duration) error
}

func (p SignerRetryPolicy) normalized() SignerRetryPolicy {
	if p.MaxAttempts <= 0 {
		p.MaxAttempts = 3
	}
	if p.InitialDelay <= 0 {
		p.InitialDelay = 25 * time.Millisecond
	}
	if p.MaxDelay <= 0 {
		p.MaxDelay = 250 * time.Millisecond
	}
	if p.MaxDelay < p.InitialDelay {
		p.MaxDelay = p.InitialDelay
	}
	if p.Sleep == nil {
		p.Sleep = sleepWithContext
	}
	return p
}

// SignerRetryMetrics is safe for concurrent use and intentionally exposes only
// counters, never payloads, key references, signatures, or signer errors.
type SignerRetryMetrics struct {
	AttemptsTotal           atomic.Uint64
	RetriesTotal            atomic.Uint64
	RetryExhaustedTotal     atomic.Uint64
	NonRetryableErrorsTotal atomic.Uint64
}

type SignerRetryMetricsSnapshot struct {
	AttemptsTotal           uint64 `json:"signer_attempts_total"`
	RetriesTotal            uint64 `json:"signer_retries_total"`
	RetryExhaustedTotal     uint64 `json:"signer_retry_exhausted_total"`
	NonRetryableErrorsTotal uint64 `json:"signer_non_retryable_errors_total"`
}

func (m *SignerRetryMetrics) Snapshot() SignerRetryMetricsSnapshot {
	if m == nil {
		return SignerRetryMetricsSnapshot{}
	}
	return SignerRetryMetricsSnapshot{
		AttemptsTotal:           m.AttemptsTotal.Load(),
		RetriesTotal:            m.RetriesTotal.Load(),
		RetryExhaustedTotal:     m.RetryExhaustedTotal.Load(),
		NonRetryableErrorsTotal: m.NonRetryableErrorsTotal.Load(),
	}
}

// RetryingMojaloopSigner wraps an HSM or delegated signing client. It retries
// only errors explicitly identified as transient and never retries a canceled
// caller context, authorization failure, malformed request, or empty signature.
type RetryingMojaloopSigner struct {
	base    MojaloopSigner
	policy  SignerRetryPolicy
	metrics *SignerRetryMetrics
}

func NewRetryingMojaloopSigner(base MojaloopSigner, policy SignerRetryPolicy, metrics *SignerRetryMetrics) (*RetryingMojaloopSigner, error) {
	if base == nil {
		return nil, errors.New("base Mojaloop signer is required")
	}
	if metrics == nil {
		metrics = &SignerRetryMetrics{}
	}
	return &RetryingMojaloopSigner{base: base, policy: policy.normalized(), metrics: metrics}, nil
}

func (s *RetryingMojaloopSigner) SignFSPIOP(ctx context.Context, method, requestURI string, body []byte) (string, error) {
	if s == nil || s.base == nil {
		return "", errors.New("Mojaloop signer is not configured")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	for attempt := 1; attempt <= s.policy.MaxAttempts; attempt++ {
		s.metrics.AttemptsTotal.Add(1)
		signature, err := s.base.SignFSPIOP(ctx, method, requestURI, body)
		if err == nil && signature != "" {
			return signature, nil
		}
		if err == nil {
			err = errors.New("signer returned an empty signature")
		}
		if !isTransientSignerError(err) || attempt == s.policy.MaxAttempts {
			if isTransientSignerError(err) && attempt == s.policy.MaxAttempts {
				s.metrics.RetryExhaustedTotal.Add(1)
			} else {
				s.metrics.NonRetryableErrorsTotal.Add(1)
			}
			return "", err
		}
		s.metrics.RetriesTotal.Add(1)
		if err := s.policy.Sleep(ctx, retryDelay(s.policy, attempt)); err != nil {
			return "", err
		}
	}
	return "", errors.New("signer retry loop terminated unexpectedly")
}

func isTransientSignerError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return false
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var networkError net.Error
	return errors.As(err, &networkError) && (networkError.Timeout() || networkError.Temporary())
}

func retryDelay(policy SignerRetryPolicy, attempt int) time.Duration {
	delay := policy.InitialDelay
	for i := 1; i < attempt && delay < policy.MaxDelay; i++ {
		if delay > policy.MaxDelay/2 {
			return policy.MaxDelay
		}
		delay *= 2
	}
	if delay > policy.MaxDelay {
		return policy.MaxDelay
	}
	return delay
}

func sleepWithContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
