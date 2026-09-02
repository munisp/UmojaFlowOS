package reconciliation

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"
)

const (
	opaEvaluationTimeout = 750 * time.Millisecond
	opaRetryAttempts     = 3
	opaRetryBaseDelay    = 50 * time.Millisecond
)

type OPAEvaluationMetrics interface {
	IncEvaluationFailure(reason string)
	IncEvaluationTimeout()
	IncRetryAttempt()
	IncRetryExhaustion()
}

func (c *Consumer) evaluateOPAWithRetry(parent context.Context, input IntentPolicyInput) (IntentPolicyDecision, error) {
	if c == nil || c.Policy == nil {
		return IntentPolicyDecision{}, errors.New("OPA policy is required")
	}
	var lastErr error
	for attempt := 1; attempt <= opaRetryAttempts; attempt++ {
		if err := parent.Err(); err != nil {
			return IntentPolicyDecision{}, err
		}
		evalCtx, cancel := context.WithTimeout(parent, opaEvaluationTimeout)
		decision, err := c.Policy.Evaluate(evalCtx, input)
		timedOut := errors.Is(err, context.DeadlineExceeded) || errors.Is(evalCtx.Err(), context.DeadlineExceeded)
		cancel()
		if err == nil {
			return decision, nil
		}
		lastErr = err
		if c.Metrics != nil {
			c.Metrics.IncEvaluationFailure(classifyOPAError(err, timedOut))
			if timedOut {
				c.Metrics.IncEvaluationTimeout()
			}
		}
		if errors.Is(err, context.Canceled) || errors.Is(parent.Err(), context.Canceled) {
			return IntentPolicyDecision{}, err
		}
		if attempt == opaRetryAttempts {
			if c.Metrics != nil {
				c.Metrics.IncRetryExhaustion()
			}
			break
		}
		if c.Metrics != nil {
			c.Metrics.IncRetryAttempt()
		}
		delay := opaRetryBaseDelay * time.Duration(1<<(attempt-1))
		timer := time.NewTimer(delay)
		select {
		case <-parent.Done():
			timer.Stop()
			return IntentPolicyDecision{}, parent.Err()
		case <-timer.C:
		}
	}
	return IntentPolicyDecision{}, fmt.Errorf("OPA evaluation exhausted after %d attempts: %w", opaRetryAttempts, lastErr)
}

func classifyOPAError(err error, timedOut bool) string {
	if timedOut || errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "network_timeout"
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "http 5"):
		return "upstream_5xx"
	case strings.Contains(message, "decode"):
		return "malformed_response"
	default:
		return "transport_or_contract"
	}
}
