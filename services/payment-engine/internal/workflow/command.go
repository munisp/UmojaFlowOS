package workflow

import (
	"errors"
	"strings"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/domain"
)

type StartInput struct {
	WorkflowID       string
	Order            domain.Order
	Policy           domain.PolicyDecision
	ProviderVerified bool
}
type StartResult struct {
	WorkflowID               string
	Status                   domain.Status
	ExternalExecutionStarted bool
}

type TemporalConfig struct {
	Namespace   string
	TaskQueue   string
	Address     string
	TLSRequired bool
}

func (c TemporalConfig) Validate() error {
	if strings.TrimSpace(c.Namespace) == "" || strings.TrimSpace(c.TaskQueue) == "" || strings.TrimSpace(c.Address) == "" {
		return errors.New("temporal namespace, task queue, and address are required")
	}
	if !c.TLSRequired {
		return errors.New("temporal transport must require TLS")
	}
	return nil
}

// EvaluateStart is deterministic workflow logic intended to run inside a Temporal workflow.
// It never invokes a payment provider; provider invocation belongs in an activity after policy and credential gates pass.
func EvaluateStart(input StartInput) (StartResult, error) {
	if strings.TrimSpace(input.WorkflowID) == "" {
		return StartResult{}, errors.New("workflow id is required")
	}
	order := input.Order
	if err := order.ApplyPolicy(input.Policy); err != nil {
		return StartResult{}, err
	}
	if !input.ProviderVerified {
		return StartResult{WorkflowID: input.WorkflowID, Status: order.Status, ExternalExecutionStarted: false}, nil
	}
	if err := order.StartExecution(true); err != nil {
		return StartResult{}, err
	}
	return StartResult{WorkflowID: input.WorkflowID, Status: order.Status, ExternalExecutionStarted: false}, nil
}
