package multirail

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeRail struct {
	name      string
	submit    Submission
	submitErr error
	query     Submission
	queryErr  error
	calls     int
}

func (f *fakeRail) Name() string { return f.name }
func (f *fakeRail) Submit(context.Context, Intent) (Submission, error) {
	f.calls++
	return f.submit, f.submitErr
}
func (f *fakeRail) Query(context.Context, Intent) (Submission, error) { return f.query, f.queryErr }
func TestSafeFallbackAfterConfirmedNonSubmission(t *testing.T) {
	p := &fakeRail{name: "yellow_card", submit: Submission{Status: Failed, RetryableWithoutBusinessEffect: true}}
	s := &fakeRail{name: "bank", submit: Submission{Status: Submitted, ProviderRef: "b-1"}}
	r, e := NewCoordinator().Execute(context.Background(), Intent{ID: "i1", IdempotencyKey: "k1", ExpiresAt: time.Now().Add(time.Minute)}, p, s)
	if e != nil || r.Rail != "bank" || s.calls != 1 {
		t.Fatalf("r=%+v e=%v", r, e)
	}
}
func TestUnknownOutcomeBlocksFallback(t *testing.T) {
	p := &fakeRail{name: "yellow_card", submit: Submission{Status: Unknown}}
	s := &fakeRail{name: "bank", submit: Submission{Status: Submitted}}
	_, e := NewCoordinator().Execute(context.Background(), Intent{ID: "i2", IdempotencyKey: "k2"}, p, s)
	if e != ErrUnknownOutcome || s.calls != 0 {
		t.Fatalf("e=%v secondary_calls=%d", e, s.calls)
	}
}
func TestPrimaryTransportErrorRequiresConfirmedQuery(t *testing.T) {
	p := &fakeRail{name: "yellow_card", submitErr: context.DeadlineExceeded, query: Submission{Status: Unknown}}
	s := &fakeRail{name: "bank", submit: Submission{Status: Submitted}}
	_, e := NewCoordinator().Execute(context.Background(), Intent{ID: "i3", IdempotencyKey: "k3"}, p, s)
	if e != ErrUnknownOutcome || s.calls != 0 {
		t.Fatalf("e=%v secondary_calls=%d", e, s.calls)
	}
}
func TestIdempotencyReturnsOriginalResult(t *testing.T) {
	p := &fakeRail{name: "yellow_card", submit: Submission{Status: Submitted, ProviderRef: "p1"}}
	s := &fakeRail{name: "bank"}
	c := NewCoordinator()
	in := Intent{ID: "i4", IdempotencyKey: "k4"}
	a, _ := c.Execute(context.Background(), in, p, s)
	b, _ := c.Execute(context.Background(), in, p, s)
	if a != b || p.calls != 1 {
		t.Fatalf("a=%+v b=%+v calls=%d", a, b, p.calls)
	}
}

type singleFlightRail struct {
	started chan struct{}
	release chan struct{}
	calls   atomic.Int64
}

func (r *singleFlightRail) Name() string { return "yellow_card" }
func (r *singleFlightRail) Submit(context.Context, Intent) (Submission, error) {
	r.calls.Add(1)
	select {
	case r.started <- struct{}{}:
	default:
	}
	<-r.release
	return Submission{Status: Submitted, ProviderRef: "single-flight-provider-ref"}, nil
}
func (r *singleFlightRail) Query(context.Context, Intent) (Submission, error) {
	return Submission{}, ErrUnknownOutcome
}

func TestConcurrentExecuteIsSingleFlight(t *testing.T) {
	const callers = 64
	rail := &singleFlightRail{started: make(chan struct{}, 1), release: make(chan struct{})}
	coordinator := NewCoordinator()
	intent := Intent{ID: "single-flight-intent", IdempotencyKey: "single-flight-key", Payload: []byte(`{"amount":100}`)}
	results := make([]Result, callers)
	errs := make([]error, callers)
	var wg sync.WaitGroup
	wg.Add(callers)
	for i := 0; i < callers; i++ {
		go func(index int) {
			defer wg.Done()
			results[index], errs[index] = coordinator.Execute(context.Background(), intent, rail, nil)
		}(i)
	}
	select {
	case <-rail.started:
	case <-time.After(2 * time.Second):
		t.Fatal("single-flight leader did not reach provider")
	}
	close(rail.release)
	wg.Wait()
	if got := rail.calls.Load(); got != 1 {
		t.Fatalf("expected exactly one provider submission, got %d", got)
	}
	for i := range results {
		if errs[i] != nil || results[i].ProviderRef != "single-flight-provider-ref" || results[i].Status != Submitted {
			t.Fatalf("caller %d received result=%+v err=%v", i, results[i], errs[i])
		}
	}
}

func TestConcurrentExecuteRejectsChangedPayloadForSameKey(t *testing.T) {
	rail := &singleFlightRail{started: make(chan struct{}, 1), release: make(chan struct{})}
	coordinator := NewCoordinator()
	first := Intent{ID: "same-key-a", IdempotencyKey: "same-key", Payload: []byte(`{"amount":100}`)}
	second := Intent{ID: "same-key-b", IdempotencyKey: "same-key", Payload: []byte(`{"amount":200}`)}
	firstDone := make(chan struct{})
	go func() {
		_, _ = coordinator.Execute(context.Background(), first, rail, nil)
		close(firstDone)
	}()
	<-rail.started
	if _, err := coordinator.Execute(context.Background(), second, rail, nil); err != ErrIdempotencyConflict {
		t.Fatalf("changed payload must be rejected, got %v", err)
	}
	close(rail.release)
	<-firstDone
	if got := rail.calls.Load(); got != 1 {
		t.Fatalf("expected one provider submission, got %d", got)
	}
}

func TestConcurrentExecuteWaiterHonorsContextCancellation(t *testing.T) {
	rail := &singleFlightRail{started: make(chan struct{}, 1), release: make(chan struct{})}
	coordinator := NewCoordinator()
	intent := Intent{ID: "cancel-waiter", IdempotencyKey: "cancel-waiter-key", Payload: []byte(`{"amount":100}`)}
	leaderDone := make(chan struct{})
	go func() {
		_, _ = coordinator.Execute(context.Background(), intent, rail, nil)
		close(leaderDone)
	}()
	<-rail.started
	waiterCtx, cancel := context.WithCancel(context.Background())
	waiterDone := make(chan error, 1)
	go func() {
		_, err := coordinator.Execute(waiterCtx, intent, rail, nil)
		waiterDone <- err
	}()
	cancel()
	select {
	case err := <-waiterDone:
		if err != context.Canceled {
			t.Fatalf("waiter error=%v, want context canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("canceled waiter remained blocked")
	}
	close(rail.release)
	select {
	case <-leaderDone:
	case <-time.After(2 * time.Second):
		t.Fatal("single-flight leader did not finish")
	}
	if got := rail.calls.Load(); got != 1 {
		t.Fatalf("expected one provider submission, got %d", got)
	}
}
