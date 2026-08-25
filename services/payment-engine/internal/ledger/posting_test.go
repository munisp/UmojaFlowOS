package ledger

import (
	"context"
	"errors"
	"testing"
	"time"
)

type postingClient struct {
	transfers []Transfer
	err       error
}

func (c *postingClient) CreateAccounts(context.Context, []Account) error { return nil }
func (c *postingClient) CreateTransfers(_ context.Context, transfers []Transfer) error {
	c.transfers = append(c.transfers, transfers...)
	return c.err
}

type postingSink struct {
	facts []PostedTransferFact
	err   error
}

func (s *postingSink) ProjectPostedTransfer(_ context.Context, fact PostedTransferFact) error {
	s.facts = append(s.facts, fact)
	return s.err
}

func validPostingRequest() PostingRequest {
	return PostingRequest{
		TransferID:      1001,
		CorrelationID:   "payment-order-1001",
		Currency:        "NGN",
		Amount:          2_500,
		DebitAccountID:  10,
		CreditAccountID: 20,
	}
}

func TestPostConfirmedTransferPostsAndProjectsFact(t *testing.T) {
	client := &postingClient{}
	sink := &postingSink{}
	when := time.Date(2026, 8, 25, 12, 0, 0, 0, time.UTC)
	service, err := NewPostingService(client, sink, func() time.Time { return when })
	if err != nil {
		t.Fatalf("construct posting service: %v", err)
	}

	fact, err := service.PostConfirmedTransfer(context.Background(), validPostingRequest())
	if err != nil {
		t.Fatalf("post confirmed transfer: %v", err)
	}
	if len(client.transfers) != 1 {
		t.Fatalf("expected exactly one TigerBeetle transfer, got %d", len(client.transfers))
	}
	if len(sink.facts) != 1 {
		t.Fatalf("expected exactly one projection fact, got %d", len(sink.facts))
	}
	if fact.TransferID != 1001 || fact.Currency != "NGN" || fact.Amount != 2_500 || !fact.PostedAt.Equal(when) {
		t.Fatalf("unexpected confirmed fact: %+v", fact)
	}
	if client.transfers[0].DebitAccountID == client.transfers[0].CreditAccountID {
		t.Fatal("posting must preserve double-entry account separation")
	}
}

func TestPostConfirmedTransferReturnsConfirmedFactWhenProjectionIsPending(t *testing.T) {
	client := &postingClient{}
	sink := &postingSink{err: errors.New("postgres unavailable")}
	service, err := NewPostingService(client, sink, time.Now)
	if err != nil {
		t.Fatalf("construct posting service: %v", err)
	}

	fact, err := service.PostConfirmedTransfer(context.Background(), validPostingRequest())
	if err == nil {
		t.Fatal("projection failure must surface to the caller")
	}
	if fact.TransferID != 1001 {
		t.Fatalf("confirmed fact must be returned for deterministic retry, got %+v", fact)
	}
	if len(client.transfers) != 1 || len(sink.facts) != 1 {
		t.Fatalf("expected one confirmed transfer and one projection attempt, got transfers=%d projections=%d", len(client.transfers), len(sink.facts))
	}
}

func TestPostingRefusesDisabledDependenciesAndMalformedRequests(t *testing.T) {
	if _, err := NewPostingService(DisabledClient{}, &postingSink{}, time.Now); err == nil {
		t.Fatal("disabled TigerBeetle client must be rejected")
	}
	if _, err := NewPostingService(&postingClient{}, DisabledProjectionSink{}, time.Now); err == nil {
		t.Fatal("disabled projection sink must be rejected")
	}

	service, err := NewPostingService(&postingClient{}, &postingSink{}, time.Now)
	if err != nil {
		t.Fatalf("construct posting service: %v", err)
	}
	request := validPostingRequest()
	request.CreditAccountID = request.DebitAccountID
	if _, err := service.PostConfirmedTransfer(context.Background(), request); err == nil {
		t.Fatal("same-account posting must be rejected")
	}
	request = validPostingRequest()
	request.Currency = "BTC"
	if _, err := service.PostConfirmedTransfer(context.Background(), request); err == nil {
		t.Fatal("unsupported currency must be rejected")
	}
}

func TestRuntimeOnlyBuildsPostingServiceWhenTigerBeetleIsEnabled(t *testing.T) {
	runtime := Runtime{Client: &postingClient{}, Backend: "disabled_without_deployed_tigerbeetle"}
	if _, err := runtime.NewPostingService(&postingSink{}, time.Now); err == nil {
		t.Fatal("disabled runtime must not create a posting service")
	}
	runtime.Backend = "configured_reachable_tigerbeetle"
	if _, err := runtime.NewPostingService(&postingSink{}, time.Now); err != nil {
		t.Fatalf("enabled runtime should build posting service: %v", err)
	}
}
