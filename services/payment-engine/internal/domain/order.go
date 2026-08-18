package domain

import (
	"errors"
	"fmt"
	"strings"
	"time"
)

type Corridor string

const (
	NigeriaNGN     Corridor = "NIGERIA_NGN"
	KenyaKES       Corridor = "KENYA_KES"
	SouthAfricaZAR Corridor = "SOUTH_AFRICA_ZAR"
)

type Status string

const (
	Draft                 Status = "DRAFT"
	PendingPolicyDecision Status = "PENDING_POLICY_DECISION"
	Blocked               Status = "BLOCKED"
	ManualReview          Status = "MANUAL_REVIEW"
	Approved              Status = "APPROVED"
	Executing             Status = "EXECUTING"
	Completed             Status = "COMPLETED"
	Failed                Status = "FAILED"
	Cancelled             Status = "CANCELLED"
)

type Money struct {
	Currency string
	Amount   string
}

type PolicyDecision struct {
	Outcome string
	Version string
}

type Order struct {
	ID             string
	IdempotencyKey string
	Corridor       Corridor
	Source         Money
	Target         Money
	Status         Status
	CreatedAt      time.Time
}

func NewOrder(id, idempotencyKey string, corridor Corridor, source, target Money, now time.Time) (Order, error) {
	if strings.TrimSpace(id) == "" || strings.TrimSpace(idempotencyKey) == "" {
		return Order{}, errors.New("order id and idempotency key are required")
	}
	if !isSupportedCorridor(corridor) {
		return Order{}, fmt.Errorf("unsupported corridor %q", corridor)
	}
	if !isSupportedCurrency(source.Currency) || !isSupportedCurrency(target.Currency) {
		return Order{}, errors.New("unsupported source or target currency")
	}
	if strings.TrimSpace(source.Amount) == "" || strings.TrimSpace(target.Amount) == "" {
		return Order{}, errors.New("source and target amounts are required")
	}
	return Order{ID: id, IdempotencyKey: idempotencyKey, Corridor: corridor, Source: source, Target: target, Status: PendingPolicyDecision, CreatedAt: now.UTC()}, nil
}

func (o *Order) ApplyPolicy(decision PolicyDecision) error {
	if o.Status != PendingPolicyDecision {
		return fmt.Errorf("policy cannot be applied from %s", o.Status)
	}
	if strings.TrimSpace(decision.Version) == "" {
		return errors.New("policy version is required")
	}
	switch decision.Outcome {
	case "ALLOW":
		o.Status = Approved
	case "MANUAL_REVIEW":
		o.Status = ManualReview
	case "BLOCK":
		o.Status = Blocked
	default:
		return fmt.Errorf("invalid policy outcome %q", decision.Outcome)
	}
	return nil
}

func (o *Order) StartExecution(providerVerified bool) error {
	if o.Status != Approved {
		return fmt.Errorf("execution cannot start from %s", o.Status)
	}
	if !providerVerified {
		return errors.New("provider authorization and credentials must be verified before execution")
	}
	o.Status = Executing
	return nil
}

func (o *Order) Complete(providerFinalityReference string) error {
	if o.Status != Executing {
		return fmt.Errorf("completion cannot occur from %s", o.Status)
	}
	if strings.TrimSpace(providerFinalityReference) == "" {
		return errors.New("provider finality reference is required")
	}
	o.Status = Completed
	return nil
}

// ResolveManualReview records a human compliance decision on an order that a
// policy evaluation escalated. Only a compliance officer may resolve it, and
// the reviewer may not be the party that submitted the order.
func (o *Order) ResolveManualReview(approve bool, reviewerRole, reviewerID, submitterID, reason string) error {
	if o.Status != ManualReview {
		return fmt.Errorf("manual review cannot be resolved from %s", o.Status)
	}
	if reviewerRole != "compliance_officer" {
		return errors.New("only a compliance officer may resolve a manual review")
	}
	if strings.TrimSpace(reviewerID) == "" {
		return errors.New("reviewer identity is required")
	}
	if reviewerID == submitterID {
		return errors.New("the submitter may not resolve their own manual review")
	}
	if strings.TrimSpace(reason) == "" {
		return errors.New("an explicit review reason is required")
	}
	if approve {
		o.Status = Approved
	} else {
		o.Status = Blocked
	}
	return nil
}

// Fail records a terminal failure reported by an authorised provider. It
// requires a provider failure reference so a failure can never be asserted
// without evidence.
func (o *Order) Fail(providerFailureReference, reason string) error {
	if o.Status != Executing {
		return fmt.Errorf("failure cannot be recorded from %s", o.Status)
	}
	if strings.TrimSpace(providerFailureReference) == "" {
		return errors.New("provider failure reference is required")
	}
	if strings.TrimSpace(reason) == "" {
		return errors.New("an explicit failure reason is required")
	}
	o.Status = Failed
	return nil
}

// Cancel withdraws an order before execution begins. Once execution has
// started, cancellation is refused because the provider owns the outcome.
func (o *Order) Cancel(reason string) error {
	switch o.Status {
	case PendingPolicyDecision, ManualReview, Approved:
		// cancellable
	default:
		return fmt.Errorf("cancellation is not permitted from %s", o.Status)
	}
	if strings.TrimSpace(reason) == "" {
		return errors.New("an explicit cancellation reason is required")
	}
	o.Status = Cancelled
	return nil
}

// IsTerminal reports whether the order can no longer transition.
func (o *Order) IsTerminal() bool {
	switch o.Status {
	case Completed, Failed, Cancelled, Blocked:
		return true
	default:
		return false
	}
}

func isSupportedCorridor(corridor Corridor) bool {
	return corridor == NigeriaNGN || corridor == KenyaKES || corridor == SouthAfricaZAR
}

func isSupportedCurrency(currency string) bool {
	switch strings.ToUpper(strings.TrimSpace(currency)) {
	case "NGN", "KES", "ZAR", "USD", "USDC", "USDT":
		return true
	default:
		return false
	}
}
