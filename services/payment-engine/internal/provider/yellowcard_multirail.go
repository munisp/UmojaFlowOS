package provider

import (
	"context"
	"errors"
	"strings"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/multirail"
)

// YellowCardMultiRail adapts one validated Yellow Card Send instruction to the
// provider-neutral rail interface. The request body is kept in memory only for
// the duration of the coordinator call and is persisted separately by the
// caller through the canonical payload binding contract.
type YellowCardMultiRail struct {
	Client *YellowCardClient
	Send   YellowCardSend
}

func (r YellowCardMultiRail) Name() string { return "yellow_card" }

func (r YellowCardMultiRail) Submit(ctx context.Context, intent multirail.Intent) (multirail.Submission, error) {
	if r.Client == nil || intent.IdempotencyKey == "" || intent.IdempotencyKey != r.Send.SequenceID {
		return multirail.Submission{}, errors.New("Yellow Card rail intent binding is invalid")
	}
	result, err := r.Client.SubmitSend(ctx, r.Send)
	if err != nil {
		return multirail.Submission{}, err
	}
	return normalizeYellowCardResult(result), nil
}

func (r YellowCardMultiRail) Query(ctx context.Context, intent multirail.Intent) (multirail.Submission, error) {
	if r.Client == nil || intent.IdempotencyKey == "" || intent.IdempotencyKey != r.Send.SequenceID {
		return multirail.Submission{}, errors.New("Yellow Card rail query binding is invalid")
	}
	result, err := r.Client.QuerySend(ctx, intent.IdempotencyKey)
	if err != nil {
		return multirail.Submission{}, err
	}
	return normalizeYellowCardResult(result), nil
}

func normalizeYellowCardResult(result YellowCardSendResult) multirail.Submission {
	status := strings.ToLower(strings.TrimSpace(result.Status))
	switch status {
	case "complete", "completed", "settled", "success", "successful":
		return multirail.Submission{ProviderRef: result.Reference, Status: multirail.Settled, Reason: "Yellow Card independently reported a completed send"}
	case "created", "accepted", "processing", "pending", "in_progress", "awaiting_approval":
		return multirail.Submission{ProviderRef: result.Reference, Status: multirail.Pending, Reason: "Yellow Card send remains provisional"}
	case "expired", "cancelled", "canceled", "rejected":
		return multirail.Submission{ProviderRef: result.Reference, Status: multirail.Failed, RetryableWithoutBusinessEffect: true, Reason: "Yellow Card explicitly reported a non-executed send"}
	case "failed", "declined", "refunded":
		// A generic failure is not proof that no business effect occurred. It
		// therefore remains unsafe for automatic failover until provider evidence
		// supplies a stronger non-submission classification.
		return multirail.Submission{ProviderRef: result.Reference, Status: multirail.Unknown, Reason: "Yellow Card failure is not independently classified as no-effect"}
	default:
		return multirail.Submission{ProviderRef: result.Reference, Status: multirail.Unknown, Reason: "unrecognized Yellow Card status"}
	}
}
