package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// AuditEvent is one immutable record of a corridor lifecycle transition.
//
// Each event chains to its predecessor via PreviousHash, so a removed or
// reordered event breaks verification. Events carry no provider credential and
// no free-form operator narrative that could be mistaken for a decision record.
type AuditEvent struct {
	Sequence     int
	OrderID      string
	Corridor     Corridor
	FromStatus   Status
	ToStatus     Status
	Reason       string
	ActorRole    string
	OccurredAt   time.Time
	PreviousHash string
	Hash         string
}

// AuditTrail is an append-only chain of lifecycle events for a single order.
type AuditTrail struct {
	orderID string
	events  []AuditEvent
}

// NewAuditTrail starts a trail for the given order.
func NewAuditTrail(orderID string) (*AuditTrail, error) {
	if strings.TrimSpace(orderID) == "" {
		return nil, errors.New("order id is required")
	}
	return &AuditTrail{orderID: orderID}, nil
}

func computeHash(event AuditEvent) string {
	payload := fmt.Sprintf(
		"%d|%s|%s|%s|%s|%s|%s|%s|%s",
		event.Sequence,
		event.OrderID,
		event.Corridor,
		event.FromStatus,
		event.ToStatus,
		event.Reason,
		event.ActorRole,
		event.OccurredAt.UTC().Format(time.RFC3339Nano),
		event.PreviousHash,
	)
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}

// Append records a transition. Every field except the chain metadata must be
// supplied by the caller: nothing is defaulted.
func (t *AuditTrail) Append(corridor Corridor, from, to Status, reason, actorRole string, occurredAt time.Time) (AuditEvent, error) {
	if strings.TrimSpace(reason) == "" {
		return AuditEvent{}, errors.New("an explicit reason is required for every lifecycle transition")
	}
	if strings.TrimSpace(actorRole) == "" {
		return AuditEvent{}, errors.New("an acting role is required for every lifecycle transition")
	}
	if occurredAt.IsZero() {
		return AuditEvent{}, errors.New("occurredAt is required")
	}
	previousHash := ""
	if len(t.events) > 0 {
		last := t.events[len(t.events)-1]
		previousHash = last.Hash
		if occurredAt.UTC().Before(last.OccurredAt.UTC()) {
			return AuditEvent{}, errors.New("audit events must be appended in non-decreasing time order")
		}
	}
	event := AuditEvent{
		Sequence:     len(t.events) + 1,
		OrderID:      t.orderID,
		Corridor:     corridor,
		FromStatus:   from,
		ToStatus:     to,
		Reason:       reason,
		ActorRole:    actorRole,
		OccurredAt:   occurredAt.UTC(),
		PreviousHash: previousHash,
	}
	event.Hash = computeHash(event)
	t.events = append(t.events, event)
	return event, nil
}

// Events returns a defensive copy so callers cannot mutate the trail.
func (t *AuditTrail) Events() []AuditEvent {
	out := make([]AuditEvent, len(t.events))
	copy(out, t.events)
	return out
}

// Verify recomputes the whole chain and reports the first inconsistency.
func (t *AuditTrail) Verify() error {
	previousHash := ""
	for index, event := range t.events {
		if event.Sequence != index+1 {
			return fmt.Errorf("event at position %d has sequence %d", index+1, event.Sequence)
		}
		if event.PreviousHash != previousHash {
			return fmt.Errorf("event %d does not chain to its predecessor", event.Sequence)
		}
		if computeHash(event) != event.Hash {
			return fmt.Errorf("event %d hash does not match its contents", event.Sequence)
		}
		previousHash = event.Hash
	}
	return nil
}
