package ledger

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// PostingRequest describes an already-authorised accounting fact. It is not a
// payment instruction: the caller must have obtained the required policy,
// provider, and human approvals before invoking this narrow boundary.
type PostingRequest struct {
	TransferID      uint64
	CorrelationID   string
	Currency        string
	Amount          uint64
	DebitAccountID  uint64
	CreditAccountID uint64
	PendingID       uint64
}

// PostingService posts a confirmed double-entry fact to TigerBeetle and then
// projects that fact to PostgreSQL through an explicit sink. A successful
// TigerBeetle call is never treated as payment completion; reconciliation is a
// separate, independent control.
type PostingService struct {
	client Client
	sink   ProjectionSink
	audit  AuditLogger
	now    func() time.Time
}

// NewPostingService refuses disabled or incomplete dependencies. This keeps an
// enabled deployment from silently accepting a posting request without a durable
// projection path.
func NewPostingService(client Client, sink ProjectionSink, now func() time.Time) (*PostingService, error) {
	return NewPostingServiceWithAuditLogger(client, sink, nil, now)
}

func NewPostingServiceWithAuditLogger(client Client, sink ProjectionSink, audit AuditLogger, now func() time.Time) (*PostingService, error) {
	if client == nil {
		return nil, errors.New("TigerBeetle client is required for posting")
	}
	if _, disabled := client.(DisabledClient); disabled {
		return nil, errors.New("TigerBeetle posting is disabled until a cluster is configured")
	}
	if sink == nil {
		return nil, errors.New("PostgreSQL projection sink is required for TigerBeetle posting")
	}
	if _, disabled := sink.(DisabledProjectionSink); disabled {
		return nil, errors.New("PostgreSQL projection sink is disabled")
	}
	if now == nil {
		now = func() time.Time { return time.Now().UTC() }
	}
	return &PostingService{client: client, sink: sink, audit: audit, now: now}, nil
}

func (s *PostingService) validateRequest(request PostingRequest) error {
	if s == nil || s.client == nil || s.sink == nil {
		return errors.New("TigerBeetle posting service is not configured")
	}
	if request.TransferID == 0 || request.DebitAccountID == 0 || request.CreditAccountID == 0 || request.Amount == 0 {
		return errors.New("transfer id, debit account, credit account, and amount are required")
	}
	if request.DebitAccountID == request.CreditAccountID {
		return errors.New("TigerBeetle posting requires distinct debit and credit accounts")
	}
	if strings.TrimSpace(request.CorrelationID) == "" {
		return errors.New("correlation id is required for TigerBeetle posting")
	}
	currency := strings.ToUpper(strings.TrimSpace(request.Currency))
	if currency != "NGN" && currency != "KES" && currency != "ZAR" && currency != "USD" && currency != "USDC" && currency != "USDT" {
		return fmt.Errorf("unsupported TigerBeetle posting currency %q", request.Currency)
	}
	return nil
}

// PostConfirmedTransfer is intentionally idempotent. The concrete TigerBeetle
// client accepts TransferExists for the same transfer ID. If projection failed
// after a confirmed TigerBeetle write, retrying this exact request reuses the
// same immutable fact and gives the projection sink another chance to persist it.
func (s *PostingService) PostConfirmedTransfer(ctx context.Context, request PostingRequest) (PostedTransferFact, error) {
	if err := s.validateRequest(request); err != nil {
		return PostedTransferFact{}, err
	}
	currency := strings.ToUpper(strings.TrimSpace(request.Currency))
	if err := s.client.CreateTransfers(ctx, []Transfer{{
		ID:              request.TransferID,
		DebitAccountID:  request.DebitAccountID,
		CreditAccountID: request.CreditAccountID,
		Amount:          request.Amount,
		Currency:        currency,
		PendingID:       request.PendingID,
	}}); err != nil {
		return PostedTransferFact{}, fmt.Errorf("post TigerBeetle transfer: %w", err)
	}
	fact := PostedTransferFact{
		TransferID:      request.TransferID,
		CorrelationID:   strings.TrimSpace(request.CorrelationID),
		Currency:        currency,
		Amount:          request.Amount,
		DebitAccountID:  request.DebitAccountID,
		CreditAccountID: request.CreditAccountID,
		PostedAt:        s.now().UTC(),
	}
	if err := ProjectConfirmedTransfer(ctx, s.sink, fact); err != nil {
		return fact, fmt.Errorf("TigerBeetle transfer is confirmed but PostgreSQL projection is pending: %w", err)
	}
	if s.audit != nil {
		if err := s.audit.WriteLedgerEvent(LedgerAuditEvent{
			Event:           "tigerbeetle.transfer_confirmed",
			OccurredAt:      fact.PostedAt,
			TransferID:      fact.TransferID,
			CorrelationID:   fact.CorrelationID,
			Currency:        fact.Currency,
			AmountMinor:     fact.Amount,
			DebitAccountID:  fact.DebitAccountID,
			CreditAccountID: fact.CreditAccountID,
			Result:          "confirmed_and_projected",
		}); err != nil {
			return fact, fmt.Errorf("TigerBeetle transfer is confirmed and projected but audit logging is pending: %w", err)
		}
	}
	return fact, nil
}

// NewPostingService creates the explicit posting boundary only when the runtime
// was built against a reachable TigerBeetle cluster. The caller still controls
// the authoritative approval and reconciliation workflow around this boundary.
func (r Runtime) NewPostingService(sink ProjectionSink, now func() time.Time) (*PostingService, error) {
	if r.Backend != "configured_reachable_tigerbeetle" {
		return nil, errors.New("TigerBeetle runtime is not enabled")
	}
	return NewPostingService(r.Client, sink, now)
}
