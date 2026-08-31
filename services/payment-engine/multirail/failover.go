package multirail

import (
	"context"
	"crypto/sha256"
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

type executionCall struct {
	digest [32]byte
	done   chan struct{}
	result Result
	err    error
}

type Coordinator struct {
	mu       sync.Mutex
	records  map[string]Result
	failures map[string]error
	bindings map[string][32]byte
	inflight map[string]*executionCall
}

func NewCoordinator() *Coordinator {
	return &Coordinator{
		records:  map[string]Result{},
		failures: map[string]error{},
		bindings: map[string][32]byte{},
		inflight: map[string]*executionCall{},
	}
}

var ErrUnknownOutcome = errors.New("provider outcome is unknown; fallback prohibited")
var ErrExpired = errors.New("payment intent expired")
var ErrIdempotencyConflict = errors.New("idempotency key is bound to a different payment intent")

func (c *Coordinator) Execute(ctx context.Context, in Intent, primary, secondary Rail) (Result, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if primary == nil {
		return Result{}, errors.New("primary rail is required")
	}
	if in.ID == "" || in.IdempotencyKey == "" {
		return Result{}, errors.New("intent and idempotency key are required")
	}
	if !in.ExpiresAt.IsZero() && time.Now().After(in.ExpiresAt) {
		return Result{}, ErrExpired
	}

	digest := sha256.Sum256(in.Payload)
	call, leader, err := c.begin(in.IdempotencyKey, digest)
	if err != nil {
		return Result{}, err
	}
	if !leader {
		select {
		case <-call.done:
			return call.result, call.err
		case <-ctx.Done():
			return Result{}, ctx.Err()
		}
	}

	result, execErr := c.execute(ctx, in, primary, secondary)
	c.finish(in.IdempotencyKey, call, result, execErr)
	return result, execErr
}

func (c *Coordinator) begin(key string, digest [32]byte) (*executionCall, bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if bound, ok := c.bindings[key]; ok && bound != digest {
		return nil, false, ErrIdempotencyConflict
	}
	if old, ok := c.records[key]; ok {
		completed := &executionCall{done: closedChannel(), result: old}
		return completed, false, nil
	}
	if oldErr, ok := c.failures[key]; ok {
		completed := &executionCall{done: closedChannel(), err: oldErr}
		return completed, false, nil
	}
	if call, ok := c.inflight[key]; ok {
		return call, false, nil
	}
	c.bindings[key] = digest
	call := &executionCall{digest: digest, done: make(chan struct{})}
	c.inflight[key] = call
	return call, true, nil
}

func closedChannel() chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}

func (c *Coordinator) finish(key string, call *executionCall, result Result, err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	call.result, call.err = result, err
	if err == nil {
		c.records[key] = result
	} else {
		// Memoizing an error prevents a caller that races after an UNKNOWN or
		// transport failure from issuing a second write under the same key.
		c.failures[key] = err
	}
	delete(c.inflight, key)
	close(call.done)
}

func (c *Coordinator) execute(ctx context.Context, in Intent, primary, secondary Rail) (Result, error) {
	out, err := primary.Submit(ctx, in)
	if err == nil {
		if out.Status == Settled || out.Status == Pending || out.Status == Submitted {
			return Result{in.ID, primary.Name(), out.ProviderRef, out.Status, out.Reason}, nil
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
	return Result{in.ID, secondary.Name(), alt.ProviderRef, alt.Status, "secondary rail selected after safe primary non-submission"}, nil
}
