package multirail

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

// UnknownState is a durable record created when a provider submission cannot be
// classified as having had no business effect. It is evidence for reconciliation,
// not an instruction to submit on another rail.
type UnknownState struct {
	Intent         Intent
	PrimaryRail    string
	ProviderRef    string
	ObservedStatus Status
	Attempts       int
	NextAttemptAt  time.Time
	LastError      string
	LeaseToken     string
}

type ReconciliationDecision string

const (
	DecisionProviderAccepted       ReconciliationDecision = "provider_accepted_no_settlement_authority"
	DecisionConfirmedNonSubmission ReconciliationDecision = "confirmed_non_submission"
	DecisionAwaitingEvidence       ReconciliationDecision = "awaiting_provider_evidence"
	DecisionQuarantined            ReconciliationDecision = "quarantined_reconciliation_failure"
)

type ReconciliationResult struct {
	IntentID          string
	IdempotencyKey    string
	PrimaryRail       string
	ProviderRef       string
	Decision          ReconciliationDecision
	ObservedStatus    Status
	SettlementAllowed bool
	Attempt           int
	DecidedAt         time.Time
	Reason            string
	EvidenceDigest    string
	LeaseToken        string
}

// UnknownStateStore must provide durable, atomic, append-only decision storage.
// Implementations should use a PostgreSQL row lock or an equivalent compare-and-set
// operation so two workers cannot reconcile the same intent concurrently.
type UnknownStateStore interface {
	Claim(ctx context.Context, idempotencyKey string, now time.Time) (UnknownState, bool, error)
	RecordDecision(ctx context.Context, result ReconciliationResult) error
	Reschedule(ctx context.Context, state UnknownState, next time.Time, reason string) error
}

type ReconciliationWorker struct {
	Store       UnknownStateStore
	Now         func() time.Time
	MaxAttempts int
	RetryAfter  time.Duration
}

var ErrReconciliationUnavailable = errors.New("unknown provider state remains unresolved")

// Reconcile performs only a read-only provider query. It never invokes Submit,
// never selects a secondary rail, and always emits SettlementAllowed=false.
func (w ReconciliationWorker) Reconcile(ctx context.Context, key string, provider Rail) (ReconciliationResult, error) {
	if w.Store == nil || provider == nil || key == "" {
		return ReconciliationResult{}, errors.New("store, provider, and idempotency key are required")
	}
	now := time.Now
	if w.Now != nil {
		now = w.Now
	}
	claimed, ok, err := w.Store.Claim(ctx, key, now().UTC())
	if err != nil {
		return ReconciliationResult{}, err
	}
	if !ok {
		return ReconciliationResult{}, ErrReconciliationUnavailable
	}
	if w.MaxAttempts <= 0 {
		w.MaxAttempts = 12
	}
	if claimed.Attempts >= w.MaxAttempts {
		result := w.result(claimed, DecisionQuarantined, Unknown, now().UTC(), "maximum reconciliation attempts exceeded")
		if err := w.Store.RecordDecision(ctx, result); err != nil {
			return ReconciliationResult{}, err
		}
		return result, ErrReconciliationUnavailable
	}

	observed, queryErr := provider.Query(ctx, claimed.Intent)
	if queryErr != nil || observed.Status == Unknown {
		next := now().UTC().Add(w.retryDelay(claimed.Attempts))
		reason := "provider query did not produce a conclusive outcome"
		if queryErr != nil {
			reason = "provider query failed; fallback remains prohibited"
		}
		if err := w.Store.Reschedule(ctx, claimed, next, reason); err != nil {
			return ReconciliationResult{}, err
		}
		return w.result(claimed, DecisionAwaitingEvidence, Unknown, now().UTC(), reason), ErrReconciliationUnavailable
	}

	decision := DecisionQuarantined
	reason := "provider result is not an accepted reconciliation state"
	switch {
	case observed.Status == Submitted || observed.Status == Pending || observed.Status == Settled:
		decision = DecisionProviderAccepted
		reason = "provider outcome independently confirmed; settlement authority remains false"
	case (observed.Status == Failed || observed.Status == Held) && observed.RetryableWithoutBusinessEffect:
		decision = DecisionConfirmedNonSubmission
		reason = "provider explicitly confirmed no business effect; secondary execution requires a separate authorized command"
	}
	result := w.result(claimed, decision, observed.Status, now().UTC(), reason)
	if err := w.Store.RecordDecision(ctx, result); err != nil {
		return ReconciliationResult{}, err
	}
	return result, nil
}

func (w ReconciliationWorker) retryDelay(attempt int) time.Duration {
	base := w.RetryAfter
	if base <= 0 {
		base = 30 * time.Second
	}
	for i := 0; i < attempt && base < 30*time.Minute; i++ {
		base *= 2
	}
	if base > 30*time.Minute {
		return 30 * time.Minute
	}
	return base
}

func evidenceDigest(s UnknownState, d ReconciliationDecision, status Status, at time.Time, reason string) string {
	payload, _ := json.Marshal(struct {
		IntentID       string                 `json:"intent_id"`
		IdempotencyKey string                 `json:"idempotency_key"`
		PrimaryRail    string                 `json:"primary_rail"`
		ProviderRef    string                 `json:"provider_ref"`
		Decision       ReconciliationDecision `json:"decision"`
		Status         Status                 `json:"status"`
		Attempt        int                    `json:"attempt"`
		Reason         string                 `json:"reason"`
	}{s.Intent.ID, s.Intent.IdempotencyKey, s.PrimaryRail, s.ProviderRef, d, status, s.Attempts, reason})
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

func (w ReconciliationWorker) result(s UnknownState, d ReconciliationDecision, status Status, at time.Time, reason string) ReconciliationResult {
	return ReconciliationResult{
		IntentID: s.Intent.ID, IdempotencyKey: s.Intent.IdempotencyKey, PrimaryRail: s.PrimaryRail,
		ProviderRef: s.ProviderRef, Decision: d, ObservedStatus: status, LeaseToken: s.LeaseToken,
		SettlementAllowed: false, Attempt: s.Attempts, DecidedAt: at, Reason: reason,
		EvidenceDigest: evidenceDigest(s, d, status, at, reason),
	}
}
