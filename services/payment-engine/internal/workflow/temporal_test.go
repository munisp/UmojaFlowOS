package workflow

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/testsuite"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/domain"
)

func approvedPolicy() domain.PolicyDecision {
	return domain.PolicyDecision{Outcome: "ALLOW", Version: "v1"}
}

// Built through the real constructor so the fixture cannot drift away from the
// invariants the domain enforces.
func sampleOrder(t *testing.T) domain.Order {
	t.Helper()
	order, err := domain.NewOrder(
		"order-1", "idempotency-key-0001", domain.SouthAfricaZAR,
		domain.Money{Currency: "ZAR", Amount: "100"},
		domain.Money{Currency: "USDC", Amount: "5"},
		time.Now(),
	)
	if err != nil {
		t.Fatalf("build order fixture: %v", err)
	}
	return order
}

// activityRegistration names the activity exactly as the worker does, so the
// test environment resolves the same activity a production worker would.
func activityRegistration() activity.RegisterOptions {
	return activity.RegisterOptions{Name: activityRecordDecision}
}

// The transport contract is the first line of defence: a worker that will
// happily talk plaintext to an arbitrary host is a credential-exfiltration
// path, not a convenience.
func TestWorkerConfigRefusesPlaintextToRemoteHosts(t *testing.T) {
	config := WorkerConfig{Address: "temporal.example.com:7233", Namespace: "default", TaskQueue: TaskQueueName}
	if err := config.validate(); err == nil {
		t.Fatal("expected plaintext to a remote host to be refused")
	}

	config.AllowInsecureLoopback = true
	if err := config.validate(); err == nil {
		t.Fatal("the loopback exemption must not extend to a remote host")
	}

	config.Address = "127.0.0.1:7233"
	if err := config.validate(); err != nil {
		t.Fatalf("loopback with explicit permission should be accepted: %v", err)
	}

	config = WorkerConfig{Address: "temporal.example.com:7233", Namespace: "default", TaskQueue: TaskQueueName, TLSRequired: true}
	if err := config.validate(); err != nil {
		t.Fatalf("TLS to a remote host must be accepted: %v", err)
	}
}

func TestWorkerConfigRequiresCompleteAddressing(t *testing.T) {
	for _, config := range []WorkerConfig{
		{Namespace: "default", TaskQueue: TaskQueueName, TLSRequired: true},
		{Address: "127.0.0.1:7233", TaskQueue: TaskQueueName, TLSRequired: true},
		{Address: "127.0.0.1:7233", Namespace: "default", TLSRequired: true},
	} {
		if err := config.validate(); err == nil {
			t.Fatalf("expected incomplete configuration %+v to be refused", config)
		}
	}
}

// Determinism and outcome, exercised through Temporal's own test environment:
// this runs the real workflow code through the real SDK, including replay.
func TestWorkflowWithholdsExecutionWithoutVerifiedProvider(t *testing.T) {
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()

	var recorded WorkflowOutput
	env.RegisterActivityWithOptions(
		func(ctx context.Context, out WorkflowOutput) error {
			recorded = out
			return nil
		},
		activityRegistration(),
	)

	env.ExecuteWorkflow(PaymentOrderWorkflow, WorkflowInput{
		WorkflowID:       "wf-1",
		Order:            sampleOrder(t),
		Policy:           approvedPolicy(),
		ProviderVerified: false,
	})

	if !env.IsWorkflowCompleted() {
		t.Fatal("workflow did not complete")
	}
	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("unexpected workflow error: %v", err)
	}

	var out WorkflowOutput
	if err := env.GetWorkflowResult(&out); err != nil {
		t.Fatalf("result: %v", err)
	}
	if out.ExternalExecutionStarted {
		t.Fatal("no provider is verified, so no external execution may be reported as started")
	}
	if !strings.Contains(out.Reason, "no credential-verified provider") {
		t.Fatalf("the withholding reason must be stated, got %q", out.Reason)
	}
	if recorded.WorkflowID != "wf-1" {
		t.Fatalf("the decision must be recorded through the activity, got %+v", recorded)
	}
}

// A workflow whose recording activity fails must not report success: the
// canonical store, not the workflow history, is the record.
func TestWorkflowFailsWhenTheDecisionCannotBeRecorded(t *testing.T) {
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()

	env.RegisterActivityWithOptions(
		func(ctx context.Context, out WorkflowOutput) error {
			return context.DeadlineExceeded
		},
		activityRegistration(),
	)

	env.ExecuteWorkflow(PaymentOrderWorkflow, WorkflowInput{
		WorkflowID:       "wf-2",
		Order:            sampleOrder(t),
		Policy:           approvedPolicy(),
		ProviderVerified: false,
	})

	if !env.IsWorkflowCompleted() {
		t.Fatal("workflow did not complete")
	}
	if env.GetWorkflowError() == nil {
		t.Fatal("a workflow that could not record its decision must not succeed")
	}
}

func TestNewWorkerRefusesToRunWithoutActivities(t *testing.T) {
	if _, err := NewWorker(nil, WorkerConfig{}, nil); err == nil {
		t.Fatal("a worker without a client must be refused")
	}
}

// Live regression against a real Temporal server. Opt-in, because it needs the
// server running; the sandbox runs `temporal server start-dev`.
func TestLiveTemporalRoundTrip(t *testing.T) {
	address := os.Getenv("TEMPORAL_LIVE_ADDRESS")
	if address == "" {
		t.Skip("set TEMPORAL_LIVE_ADDRESS to run the live durability regression")
	}

	config := WorkerConfig{
		Address:               address,
		Namespace:             "default",
		TaskQueue:             TaskQueueName,
		AllowInsecureLoopback: true,
	}

	c, err := NewClient(config)
	if err != nil {
		t.Fatalf("dial temporal: %v", err)
	}
	defer c.Close()

	var mu sync.Mutex
	var recorded []WorkflowOutput
	activities := RecordingActivities{Recorder: func(ctx context.Context, out WorkflowOutput) error {
		mu.Lock()
		defer mu.Unlock()
		recorded = append(recorded, out)
		return nil
	}}

	w, err := NewWorker(c, config, activities)
	if err != nil {
		t.Fatalf("build worker: %v", err)
	}
	if err := w.Start(); err != nil {
		t.Fatalf("start worker: %v", err)
	}
	defer w.Stop()

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	run, err := c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{
		ID:        "umojaflowos-live-" + time.Now().UTC().Format("20060102150405.000000000"),
		TaskQueue: TaskQueueName,
	}, PaymentOrderWorkflowName, WorkflowInput{
		WorkflowID:       "wf-live",
		Order:            sampleOrder(t),
		Policy:           approvedPolicy(),
		ProviderVerified: false,
	})
	if err != nil {
		t.Fatalf("start workflow: %v", err)
	}

	var out WorkflowOutput
	if err := run.Get(ctx, &out); err != nil {
		t.Fatalf("workflow result: %v", err)
	}
	if out.ExternalExecutionStarted {
		t.Fatal("the live workflow must also withhold execution without a verified provider")
	}
	if out.RecordedAt.IsZero() {
		t.Fatal("the workflow must stamp its decision time from the workflow clock")
	}

	mu.Lock()
	defer mu.Unlock()
	if len(recorded) != 1 {
		t.Fatalf("expected exactly one recorded decision, got %d", len(recorded))
	}
	if recorded[0].WorkflowID != "wf-live" {
		t.Fatalf("unexpected recorded decision: %+v", recorded[0])
	}
}
