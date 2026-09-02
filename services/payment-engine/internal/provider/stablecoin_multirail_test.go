package provider

import (
	"context"
	"errors"
	"testing"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/multirail"
)

type stablecoinClientMock struct { submit StablecoinExecutionResponse; query StablecoinExecutionResponse; request StablecoinExecutionRequest }
func (m *stablecoinClientMock) Submit(_ context.Context, r StablecoinExecutionRequest) (StablecoinExecutionResponse, error) { m.request = r; return m.submit, nil }
func (m *stablecoinClientMock) Query(_ context.Context, r StablecoinExecutionRequest) (StablecoinExecutionResponse, error) { m.request = r; return m.query, nil }

func stablecoinIntent() multirail.Intent { return multirail.Intent{ID:"intent-1", IdempotencyKey:"idem-1", Asset:"USDC", Fiat:"NGN", AmountMinor:125000, Payload:[]byte(`{"asset":"USDC","fiat":"NGN","amount_minor":125000}`)} }

func TestStablecoinRailBindsPayloadAndOnrampDirection(t *testing.T) {
	mock := &stablecoinClientMock{submit: StablecoinExecutionResponse{ProviderRef:"p-1", Status:multirail.Pending}}
	r, err := NewStablecoinRail("approved-stablecoin", StablecoinOnramp, mock); if err != nil { t.Fatal(err) }
	if _, err := r.Submit(context.Background(), stablecoinIntent()); err != nil { t.Fatal(err) }
	if mock.request.Direction != StablecoinOnramp || mock.request.PayloadSHA256 == "" || mock.request.IdempotencyKey != "idem-1" { t.Fatalf("request binding not preserved: %#v", mock.request) }
}

func TestStablecoinRailSupportsOfframp(t *testing.T) {
	mock := &stablecoinClientMock{submit: StablecoinExecutionResponse{ProviderRef:"p-2", Status:multirail.Settled}}
	r, err := NewStablecoinRail("approved-stablecoin", StablecoinOfframp, mock); if err != nil { t.Fatal(err) }
	out, err := r.Submit(context.Background(), stablecoinIntent()); if err != nil { t.Fatal(err) }
	if out.Status != multirail.Settled || mock.request.Direction != StablecoinOfframp { t.Fatalf("unexpected result/request: %#v %#v", out, mock.request) }
}

func TestStablecoinRailRejectsUnknown(t *testing.T) {
	mock := &stablecoinClientMock{submit: StablecoinExecutionResponse{ProviderRef:"p-3", Status:multirail.Unknown}}
	r, _ := NewStablecoinRail("approved-stablecoin", StablecoinOnramp, mock)
	if _, err := r.Submit(context.Background(), stablecoinIntent()); !errors.Is(err, multirail.ErrUnknownOutcome) { t.Fatalf("expected unknown outcome, got %v", err) }
}

func TestStablecoinRailRequiresProviderReference(t *testing.T) {
	mock := &stablecoinClientMock{submit: StablecoinExecutionResponse{Status:multirail.Pending}}
	r, _ := NewStablecoinRail("approved-stablecoin", StablecoinOnramp, mock)
	if _, err := r.Submit(context.Background(), stablecoinIntent()); err == nil { t.Fatal("expected missing provider reference error") }
}

func TestStablecoinRailRejectsMissingCanonicalPayload(t *testing.T) {
	mock := &stablecoinClientMock{submit: StablecoinExecutionResponse{ProviderRef:"p-4", Status:multirail.Pending}}
	r, _ := NewStablecoinRail("approved-stablecoin", StablecoinOnramp, mock)
	in := stablecoinIntent(); in.Payload = nil
	if _, err := r.Submit(context.Background(), in); err == nil { t.Fatal("expected missing payload error") }
}

func TestStablecoinRailQueryIsReadOnlyContract(t *testing.T) {
	mock := &stablecoinClientMock{query: StablecoinExecutionResponse{ProviderRef:"p-5", Status:multirail.Failed, RetryableWithoutBusinessEffect:true}}
	r, _ := NewStablecoinRail("approved-stablecoin", StablecoinOfframp, mock)
	out, err := r.Query(context.Background(), stablecoinIntent()); if err != nil { t.Fatal(err) }
	if out.Status != multirail.Failed || !out.RetryableWithoutBusinessEffect { t.Fatalf("unexpected query result: %#v", out) }
}
