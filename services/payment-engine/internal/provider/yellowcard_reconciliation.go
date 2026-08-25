package provider

import (
	"context"
	"errors"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/ledger"
)

// YellowCardProviderReference is returned only by a provider-specific,
// authenticated, read-only lookup outside the inbound webhook request path.
type YellowCardProviderReference struct {
	EventID       string
	SequenceID    string
	Status        string
	CorrelationID string
	VerifiedAt    time.Time
}

// YellowCardReferenceVerifier independently verifies the provider event after
// HMAC validation. It must not call a payment execution or settlement endpoint.
type YellowCardReferenceVerifier interface {
	VerifyYellowCardReference(context.Context, WebhookEvidence) (YellowCardProviderReference, error)
}

// LedgerReconciliationEvidence resolves an already-confirmed TigerBeetle fact
// and its PostgreSQL projection. It cannot create a transfer or projection.
type LedgerReconciliationEvidence interface {
	ResolveLedgerEvidence(context.Context, YellowCardProviderReference) (ledger.PostedTransferFact, ledger.ProjectionRecord, error)
}

// ReconciliationDecision is immutable evidence that all observed systems agree.
// SettlementAuthorized is deliberately fixed to false: reconciliation is an
// evidence gate, not a release-of-funds command.
type ReconciliationDecision struct {
	Provider          string    `json:"provider"`
	EventID           string    `json:"event_id"`
	SequenceID        string    `json:"sequence_id"`
	CorrelationID     string    `json:"correlation_id"`
	Decision          string    `json:"decision"`
	ReconciledAt      time.Time `json:"reconciled_at"`
	SettlementAllowed bool      `json:"settlement_allowed"`
}

type ReconciliationDecisionStore interface {
	RecordReconciliationDecision(context.Context, ReconciliationDecision) error
}

// YellowCardReconciler never handles HTTP secrets and never advances a payment
// state. A success means the verified webhook, provider read-only lookup, and
// confirmed TigerBeetle/PostgreSQL evidence agree at one point in time.
type YellowCardReconciler struct {
	Provider YellowCardReferenceVerifier
	Ledger   LedgerReconciliationEvidence
	Store    ReconciliationDecisionStore
	Now      func() time.Time
}

func (r YellowCardReconciler) Reconcile(ctx context.Context, webhook WebhookEvidence) (ReconciliationDecision, error) {
	if webhook.Provider != "yellowcard" || webhook.EventID == "" || webhook.SequenceID == "" || webhook.Reconciliation != "pending_independent_provider_and_ledger_reconciliation" || webhook.SettlementAllowed {
		return ReconciliationDecision{}, errors.New("complete pending Yellow Card webhook evidence is required")
	}
	if r.Provider == nil || r.Ledger == nil || r.Store == nil {
		return ReconciliationDecision{}, errors.New("provider, ledger, and immutable reconciliation decision store are required")
	}
	providerReference, err := r.Provider.VerifyYellowCardReference(ctx, webhook)
	if err != nil {
		return ReconciliationDecision{}, errors.New("independent provider reference verification failed")
	}
	if providerReference.EventID != webhook.EventID || providerReference.SequenceID != webhook.SequenceID || providerReference.Status != webhook.Status || providerReference.CorrelationID == "" || providerReference.VerifiedAt.IsZero() {
		return ReconciliationDecision{}, errors.New("provider reference does not agree with verified webhook evidence")
	}
	transfer, projection, err := r.Ledger.ResolveLedgerEvidence(ctx, providerReference)
	if err != nil {
		return ReconciliationDecision{}, errors.New("confirmed ledger reconciliation evidence is unavailable")
	}
	if transfer.CorrelationID != providerReference.CorrelationID {
		return ReconciliationDecision{}, errors.New("provider reference and TigerBeetle correlation identifiers do not agree")
	}
	if err := ledger.VerifyProjection(transfer, projection); err != nil {
		return ReconciliationDecision{}, err
	}
	now := time.Now
	if r.Now != nil {
		now = r.Now
	}
	decision := ReconciliationDecision{
		Provider:          "yellowcard",
		EventID:           webhook.EventID,
		SequenceID:        webhook.SequenceID,
		CorrelationID:     providerReference.CorrelationID,
		Decision:          "reconciled_without_settlement_authority",
		ReconciledAt:      now().UTC(),
		SettlementAllowed: false,
	}
	if err := r.Store.RecordReconciliationDecision(ctx, decision); err != nil {
		return ReconciliationDecision{}, errors.New("could not persist immutable reconciliation decision")
	}
	return decision, nil
}
