package provider

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/multirail"
)

// StablecoinDirection identifies the settlement direction. The adapter does
// not move funds by itself; it delegates to an approved provider client.
type StablecoinDirection string

const (
	StablecoinOnramp  StablecoinDirection = "onramp"
	StablecoinOfframp StablecoinDirection = "offramp"
)

// StablecoinExecutionRequest is the only provider request shape emitted by the
// adapter. Payload is retained by the caller for reconciliation but is never
// logged by this package.
type StablecoinExecutionRequest struct {
	IntentID      string
	IdempotencyKey string
	PayloadSHA256 string
	Direction     StablecoinDirection
	Asset         string
	Fiat          string
	AmountMinor   int64
}

type StablecoinExecutionResponse struct {
	ProviderRef                    string
	Status                        multirail.Status
	RetryableWithoutBusinessEffect bool
	Reason                        string
}

// StablecoinExecutionClient is implemented by an approved issuer, liquidity,
// custody, or fiat-rail connector. Query must be read-only.
type StablecoinExecutionClient interface {
	Submit(context.Context, StablecoinExecutionRequest) (StablecoinExecutionResponse, error)
	Query(context.Context, StablecoinExecutionRequest) (StablecoinExecutionResponse, error)
}

type StablecoinRail struct {
	client    StablecoinExecutionClient
	name      string
	direction StablecoinDirection
}

func NewStablecoinRail(name string, direction StablecoinDirection, client StablecoinExecutionClient) (*StablecoinRail, error) {
	if strings.TrimSpace(name) == "" {
		return nil, errors.New("stablecoin rail name is required")
	}
	if direction != StablecoinOnramp && direction != StablecoinOfframp {
		return nil, errors.New("stablecoin direction must be onramp or offramp")
	}
	if client == nil {
		return nil, errors.New("stablecoin execution client is required")
	}
	return &StablecoinRail{client: client, name: name, direction: direction}, nil
}

func (r *StablecoinRail) Name() string { return r.name }

func stablecoinRequest(in multirail.Intent, direction StablecoinDirection) (StablecoinExecutionRequest, error) {
	if strings.TrimSpace(in.ID) == "" || strings.TrimSpace(in.IdempotencyKey) == "" {
		return StablecoinExecutionRequest{}, errors.New("stablecoin intent and idempotency key are required")
	}
	if in.AmountMinor <= 0 {
		return StablecoinExecutionRequest{}, errors.New("stablecoin amount must be positive")
	}
	if strings.TrimSpace(in.Asset) == "" || strings.TrimSpace(in.Fiat) == "" {
		return StablecoinExecutionRequest{}, errors.New("stablecoin asset and fiat are required")
	}
	if len(in.Payload) == 0 {
		return StablecoinExecutionRequest{}, errors.New("canonical stablecoin payload is required")
	}
	digest := sha256.Sum256(in.Payload)
	return StablecoinExecutionRequest{
		IntentID: in.ID, IdempotencyKey: in.IdempotencyKey,
		PayloadSHA256: fmt.Sprintf("%x", digest[:]), Direction: direction,
		Asset: strings.ToUpper(strings.TrimSpace(in.Asset)), Fiat: strings.ToUpper(strings.TrimSpace(in.Fiat)), AmountMinor: in.AmountMinor,
	}, nil
}

func validateStablecoinResponse(out StablecoinExecutionResponse) (multirail.Submission, error) {
	switch out.Status {
	case multirail.Submitted, multirail.Pending, multirail.Settled:
		if strings.TrimSpace(out.ProviderRef) == "" {
			return multirail.Submission{}, errors.New("stablecoin provider reference is required for a non-terminal or settled result")
		}
	case multirail.Failed, multirail.Held:
		if strings.TrimSpace(out.ProviderRef) == "" && !out.RetryableWithoutBusinessEffect {
			return multirail.Submission{}, errors.New("stablecoin failed/held result requires provider reference unless explicitly non-submitting")
		}
	case multirail.Unknown:
		return multirail.Submission{}, multirail.ErrUnknownOutcome
	default:
		return multirail.Submission{}, fmt.Errorf("unsupported stablecoin provider status %q", out.Status)
	}
	return multirail.Submission{ProviderRef: out.ProviderRef, Status: out.Status, RetryableWithoutBusinessEffect: out.RetryableWithoutBusinessEffect, Reason: out.Reason}, nil
}

func (r *StablecoinRail) Submit(ctx context.Context, in multirail.Intent) (multirail.Submission, error) {
	if r == nil || r.client == nil { return multirail.Submission{}, errors.New("stablecoin rail is not configured") }
	req, err := stablecoinRequest(in, r.direction); if err != nil { return multirail.Submission{}, err }
	out, err := r.client.Submit(ctx, req)
	if err != nil { return multirail.Submission{}, err }
	return validateStablecoinResponse(out)
}

func (r *StablecoinRail) Query(ctx context.Context, in multirail.Intent) (multirail.Submission, error) {
	if r == nil || r.client == nil { return multirail.Submission{}, errors.New("stablecoin rail is not configured") }
	req, err := stablecoinRequest(in, r.direction); if err != nil { return multirail.Submission{}, err }
	out, err := r.client.Query(ctx, req)
	if err != nil { return multirail.Submission{}, err }
	return validateStablecoinResponse(out)
}
