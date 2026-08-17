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
