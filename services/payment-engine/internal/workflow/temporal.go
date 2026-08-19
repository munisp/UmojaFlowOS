// Package workflow hosts the durable payment-order workflow.
//
// Why Temporal is used here, and what it is deliberately NOT used for.
//
// A cross-border payment order passes through validation, policy evaluation,
// counterparty checks, and — only once a credential-verified provider exists —
// execution. Those steps span services and minutes, and a process restart
// halfway through must not leave an order in an unknown state. That is exactly
// the problem Temporal solves: the workflow's progress is durable, so a crashed
// worker resumes from its last completed step rather than re-running side
// effects or losing the order.
//
// What Temporal must NOT do here is grant authority. A durable workflow that
// can move money is more dangerous than a fragile one, because a replayed
// history could re-issue a transfer. So:
//
//   - The workflow function is pure decision logic. It calls activities for
//     I/O, and no activity in this file contacts a payment provider.
//   - Execution remains gated on `ProviderVerified`, which the workflow
//     receives as an input rather than determining for itself.
//   - Every terminal state is recorded through an activity that writes to the
//     canonical store, so the workflow's history is evidence, not the record.
package workflow

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/domain"
)

// TaskQueueName is the single queue this service polls. Kept as a constant so
// the worker and any starter cannot disagree about it.
const TaskQueueName = "umojaflowos-payment-orders"

// PaymentOrderWorkflowName is the registered workflow type.
const PaymentOrderWorkflowName = "PaymentOrderWorkflow"

// WorkflowInput is the durable input to a payment-order workflow.
type WorkflowInput struct {
	WorkflowID       string                `json:"workflowId"`
	Order            domain.Order          `json:"order"`
	Policy           domain.PolicyDecision `json:"policy"`
	ProviderVerified bool                  `json:"providerVerified"`
}

// WorkflowOutput is the durable result.
type WorkflowOutput struct {
	WorkflowID               string        `json:"workflowId"`
	Status                   domain.Status `json:"status"`
	ExternalExecutionStarted bool          `json:"externalExecutionStarted"`
	RecordedAt               time.Time     `json:"recordedAt"`
	// Reason is populated when execution was withheld, so an operator reading
	// workflow history sees why rather than inferring it from a false flag.
	Reason string `json:"reason,omitempty"`
}

// Activities carries the side-effecting steps. It is an interface so a worker
// can be constructed against the real recorder or a test recorder without the
// workflow logic changing.
type Activities interface {
	// RecordDecision persists the workflow's outcome to the canonical store.
	RecordDecision(ctx context.Context, out WorkflowOutput) error
}

// activityRecordDecision is the registered activity name.
const activityRecordDecision = "RecordDecision"

// PaymentOrderWorkflow is deterministic. It performs no I/O directly, reads no
// clock other than Temporal's, and generates no randomness, so replay produces
// an identical history.
func PaymentOrderWorkflow(ctx workflow.Context, input WorkflowInput) (WorkflowOutput, error) {
	options := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: time.Second,
			MaximumInterval: 10 * time.Second,
			// A recording failure is worth retrying a bounded number of times;
			// retrying forever would hide a persistent store outage.
			MaximumAttempts: 5,
			// A refusal by the store is a decision, not a blip.
			NonRetryableErrorTypes: []string{"InvalidDecision"},
		},
	}
	ctx = workflow.WithActivityOptions(ctx, options)

	result, err := EvaluateStart(StartInput{
		WorkflowID:       input.WorkflowID,
		Order:            input.Order,
		Policy:           input.Policy,
		ProviderVerified: input.ProviderVerified,
	})
	if err != nil {
		// A rejected order is a legitimate business outcome, but it is still an
		// error to the caller: nothing was started.
		return WorkflowOutput{}, temporal.NewNonRetryableApplicationError(
			err.Error(), "InvalidDecision", err)
	}

	out := WorkflowOutput{
		WorkflowID:               result.WorkflowID,
		Status:                   result.Status,
		ExternalExecutionStarted: result.ExternalExecutionStarted,
		RecordedAt:               workflow.Now(ctx).UTC(),
	}
	if !input.ProviderVerified {
		out.Reason = "execution withheld: no credential-verified provider is connected"
	} else if !result.ExternalExecutionStarted {
		out.Reason = "execution withheld: provider invocation is not enabled in this deployment"
	}

	if err := workflow.ExecuteActivity(ctx, activityRecordDecision, out).Get(ctx, nil); err != nil {
		return WorkflowOutput{}, err
	}
	return out, nil
}

// WorkerConfig describes how to reach Temporal.
type WorkerConfig struct {
	Address     string
	Namespace   string
	TaskQueue   string
	TLSRequired bool
	// AllowInsecureLoopback permits a plaintext connection to 127.0.0.1 only.
	// A development Temporal server has no TLS; refusing it outright would mean
	// the durable path could never be exercised before production, which is how
	// integration bugs reach production. The exemption is narrow: loopback
	// only, and it must be requested explicitly.
	AllowInsecureLoopback bool
}

func (c WorkerConfig) validate() error {
	if strings.TrimSpace(c.Address) == "" || strings.TrimSpace(c.Namespace) == "" || strings.TrimSpace(c.TaskQueue) == "" {
		return errors.New("temporal address, namespace, and task queue are required")
	}
	if c.TLSRequired {
		return nil
	}
	if !c.AllowInsecureLoopback {
		return errors.New("temporal transport must require TLS unless loopback is explicitly permitted")
	}
	if !isLoopback(c.Address) {
		return fmt.Errorf("plaintext temporal transport is permitted on loopback only, got %q", c.Address)
	}
	return nil
}

func isLoopback(address string) bool {
	host := address
	if index := strings.LastIndex(address, ":"); index > 0 {
		host = address[:index]
	}
	return host == "127.0.0.1" || host == "localhost" || host == "[::1]"
}

// RecordingActivities adapts a decision recorder into the activity interface.
type RecordingActivities struct {
	Recorder func(ctx context.Context, out WorkflowOutput) error
}

// RecordDecision persists the workflow outcome.
func (a RecordingActivities) RecordDecision(ctx context.Context, out WorkflowOutput) error {
	if a.Recorder == nil {
		return errors.New("no decision recorder is configured")
	}
	activity.GetLogger(ctx).Info("recording payment order decision", "workflowId", out.WorkflowID)
	return a.Recorder(ctx, out)
}

// NewClient dials Temporal after validating the transport contract.
func NewClient(config WorkerConfig) (client.Client, error) {
	if err := config.validate(); err != nil {
		return nil, err
	}
	return client.Dial(client.Options{
		HostPort:  config.Address,
		Namespace: config.Namespace,
	})
}

// NewWorker builds a worker with the workflow and activities registered.
func NewWorker(c client.Client, config WorkerConfig, activities Activities) (worker.Worker, error) {
	if c == nil {
		return nil, errors.New("a temporal client is required")
	}
	if activities == nil {
		return nil, errors.New("activities are required; a worker with no recorder would silently lose decisions")
	}
	w := worker.New(c, config.TaskQueue, worker.Options{})
	w.RegisterWorkflowWithOptions(PaymentOrderWorkflow, workflow.RegisterOptions{Name: PaymentOrderWorkflowName})
	w.RegisterActivityWithOptions(activities.RecordDecision, activity.RegisterOptions{Name: activityRecordDecision})
	return w, nil
}
