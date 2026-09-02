package reconciliation

import (
	"context"
	"errors"
	"fmt"
	"net"
	"testing"
	"time"
)

type retryTestPolicy struct {
	calls  int
	errors []error
}

func (p *retryTestPolicy) Evaluate(context.Context, IntentPolicyInput) (IntentPolicyDecision, error) {
	p.calls++
	if len(p.errors) == 0 {
		return IntentPolicyDecision{Allow: true, Reason: "ok"}, nil
	}
	err := p.errors[0]
	p.errors = p.errors[1:]
	return IntentPolicyDecision{}, err
}

type retryTestMetrics struct {
	failures      map[string]int
	timeouts      int
	retryAttempts int
	exhaustions   int
}

func (m *retryTestMetrics) IncEvaluationFailure(reason string) {
	if m.failures == nil {
		m.failures = map[string]int{}
	}
	m.failures[reason]++
}
func (m *retryTestMetrics) IncEvaluationTimeout() { m.timeouts++ }
func (m *retryTestMetrics) IncRetryAttempt()      { m.retryAttempts++ }
func (m *retryTestMetrics) IncRetryExhaustion()   { m.exhaustions++ }

func TestClassifyOPAError(t *testing.T) {
	var timeoutErr net.Error = &testNetError{timeout: true}
	cases := []struct {
		name     string
		err      error
		timedOut bool
		want     string
	}{
		{"deadline", context.DeadlineExceeded, true, "timeout"},
		{"network timeout", timeoutErr, false, "network_timeout"},
		{"upstream", errors.New("OPA returned HTTP 503"), false, "upstream_5xx"},
		{"malformed", errors.New("decode OPA response: invalid character"), false, "malformed_response"},
		{"contract", errors.New("OPA result is absent"), false, "transport_or_contract"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyOPAError(tc.err, tc.timedOut); got != tc.want {
				t.Fatalf("classifyOPAError() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestEvaluateOPAWithRetryRecoversAndCountsAttempts(t *testing.T) {
	policy := &retryTestPolicy{errors: []error{errors.New("OPA returned HTTP 503"), errors.New("decode OPA response")}}
	metrics := &retryTestMetrics{}
	consumer := &Consumer{Policy: policy, Metrics: metrics}

	decision, err := consumer.evaluateOPAWithRetry(context.Background(), IntentPolicyInput{})
	if err != nil || !decision.Allow {
		t.Fatalf("evaluateOPAWithRetry() decision=%+v err=%v", decision, err)
	}
	if policy.calls != 3 || metrics.retryAttempts != 2 || metrics.exhaustions != 0 {
		t.Fatalf("calls=%d retry_attempts=%d exhaustions=%d", policy.calls, metrics.retryAttempts, metrics.exhaustions)
	}
	if metrics.failures["upstream_5xx"] != 1 || metrics.failures["malformed_response"] != 1 {
		t.Fatalf("failure classes=%v", metrics.failures)
	}
}

func TestEvaluateOPAWithRetryTimeoutExhaustion(t *testing.T) {
	policy := &retryTestPolicy{errors: []error{context.DeadlineExceeded, context.DeadlineExceeded, context.DeadlineExceeded}}
	metrics := &retryTestMetrics{}
	consumer := &Consumer{Policy: policy, Metrics: metrics}

	_, err := consumer.evaluateOPAWithRetry(context.Background(), IntentPolicyInput{})
	if err == nil || policy.calls != opaRetryAttempts {
		t.Fatalf("err=%v calls=%d", err, policy.calls)
	}
	if metrics.timeouts != opaRetryAttempts || metrics.retryAttempts != opaRetryAttempts-1 || metrics.exhaustions != 1 {
		t.Fatalf("timeouts=%d retries=%d exhaustions=%d", metrics.timeouts, metrics.retryAttempts, metrics.exhaustions)
	}
	if metrics.failures["timeout"] != opaRetryAttempts {
		t.Fatalf("failure classes=%v", metrics.failures)
	}
}

func TestEvaluateOPAWithRetryStopsOnCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	metrics := &retryTestMetrics{}
	consumer := &Consumer{Policy: &retryTestPolicy{errors: []error{errors.New("unavailable")}}, Metrics: metrics}

	_, err := consumer.evaluateOPAWithRetry(ctx, IntentPolicyInput{})
	if !errors.Is(err, context.Canceled) || metrics.retryAttempts != 0 {
		t.Fatalf("err=%v retry_attempts=%d", err, metrics.retryAttempts)
	}
}

type testNetError struct{ timeout bool }

func (e *testNetError) Error() string   { return fmt.Sprintf("network timeout: %t", e.timeout) }
func (e *testNetError) Timeout() bool   { return e.timeout }
func (e *testNetError) Temporary() bool { return e.timeout }
func (e *testNetError) Unwrap() error   { return nil }

var _ = time.Millisecond
