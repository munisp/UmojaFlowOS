package multirail

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

type Status string

const (
	Prepared  Status = "prepared"
	Submitted Status = "submitted"
	Pending   Status = "pending"
	Settled   Status = "settled"
	Held      Status = "held"
	Failed    Status = "failed"
	Unknown   Status = "unknown"
)

type Intent struct {
	ID, IdempotencyKey, Asset, Fiat string
	AmountMinor                     int64
	ExpiresAt                       time.Time
	// Payload is the canonical provider request bytes. It is never logged; it is
	// retained only by the durable reconciliation store for replay binding.
	Payload []byte
}
type Result struct {
	IntentID, Rail, ProviderRef string
	Status                      Status
	Reason                      string
}
type Submission struct {
	ProviderRef                    string
	Status                         Status
	RetryableWithoutBusinessEffect bool
	Reason                         string
}

type Rail interface {
	Name() string
	Submit(context.Context, Intent) (Submission, error)
	Query(context.Context, Intent) (Submission, error)
}

type Coordinator struct {
	mu      sync.Mutex
	records map[string]Result
}

func NewCoordinator() *Coordinator { return &Coordinator{records: map[string]Result{}} }

var ErrUnknownOutcome = errors.New("provider outcome is unknown; fallback prohibited")
var ErrExpired = errors.New("payment intent expired")

func (c *Coordinator) Execute(ctx context.Context, in Intent, primary, secondary Rail) (Result, error) {
	if primary == nil {
		return Result{}, errors.New("primary rail is required")
	}
	if in.ID == "" || in.IdempotencyKey == "" {
		return Result{}, errors.New("intent and idempotency key are required")
	}
	if !in.ExpiresAt.IsZero() && time.Now().After(in.ExpiresAt) {
		return Result{}, ErrExpired
	}
	c.mu.Lock()
	if r, ok := c.records[in.IdempotencyKey]; ok {
		c.mu.Unlock()
		return r, nil
	}
	c.mu.Unlock()
	out, err := primary.Submit(ctx, in)
	if err == nil {
		if out.Status == Settled || out.Status == Pending || out.Status == Submitted {
			return c.record(in, Result{in.ID, primary.Name(), out.ProviderRef, out.Status, out.Reason})
		}
		if out.Status == Unknown || !out.RetryableWithoutBusinessEffect {
			return Result{}, ErrUnknownOutcome
		}
	} else {
		q, qerr := primary.Query(ctx, in)
		if qerr != nil || (q.Status != Failed && q.Status != Held) || !q.RetryableWithoutBusinessEffect {
			return Result{}, ErrUnknownOutcome
		}
		out = q
	}
	if out.Status != Failed && out.Status != Held && !out.RetryableWithoutBusinessEffect {
		return Result{}, fmt.Errorf("primary not safely retryable: %w", ErrUnknownOutcome)
	}
	if secondary == nil {
		return Result{}, errors.New("secondary rail is required after safe primary failure")
	}
	alt, err := secondary.Submit(ctx, in)
	if err != nil {
		return Result{}, err
	}
	if alt.Status == Unknown || (alt.Status != Submitted && alt.Status != Pending && alt.Status != Settled) {
		return Result{}, ErrUnknownOutcome
	}
	return c.record(in, Result{in.ID, secondary.Name(), alt.ProviderRef, alt.Status, "secondary rail selected after safe primary non-submission"})
}
func (c *Coordinator) record(in Intent, r Result) (Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if old, ok := c.records[in.IdempotencyKey]; ok {
		return old, nil
	}
	c.records[in.IdempotencyKey] = r
	return r, nil
}
