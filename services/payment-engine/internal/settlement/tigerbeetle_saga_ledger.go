package settlement

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/ledger"
)

// LedgerAccounts is resolved only from tenant-governed PostgreSQL bindings.
// It is intentionally absent from Intent so callers cannot choose the debit or
// credit account for a settlement request.
type LedgerAccounts struct {
	DebitAccountID  uint64
	CreditAccountID uint64
}

type AccountResolver interface {
	ResolveSettlementAccounts(context.Context, Intent) (LedgerAccounts, error)
}

// PostgresAccountResolver resolves an active exact binding under transaction-
// local tenant identity. It does not fall back to another tenant, direction,
// currency, or corridor when the requested binding is absent.
type PostgresAccountResolver struct{ DB *sql.DB }

func (r *PostgresAccountResolver) ResolveSettlementAccounts(ctx context.Context, in Intent) (LedgerAccounts, error) {
	if r == nil || r.DB == nil {
		return LedgerAccounts{}, errors.New("PostgreSQL account resolver is required")
	}
	if err := validateIntent(in); err != nil {
		return LedgerAccounts{}, err
	}
	tx, err := r.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return LedgerAccounts{}, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `SELECT set_config('umoja.tenant_id', $1, true)`, in.TenantID); err != nil {
		return LedgerAccounts{}, fmt.Errorf("bind account resolver tenant: %w", err)
	}
	var debit, credit int64
	err = tx.QueryRowContext(ctx, `
		SELECT debit_account_id,credit_account_id
		FROM settlement_account_binding
		WHERE tenant_id=$1 AND direction=$2 AND asset=$3 AND fiat=$4 AND corridor_id=$5 AND active=true`,
		in.TenantID, string(in.Direction), strings.ToUpper(in.Asset), strings.ToUpper(in.Fiat), strings.TrimSpace(in.CorridorID),
	).Scan(&debit, &credit)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return LedgerAccounts{}, errors.New("active tenant settlement account binding is unavailable")
		}
		return LedgerAccounts{}, err
	}
	if debit <= 0 || credit <= 0 || debit == credit {
		return LedgerAccounts{}, errors.New("tenant settlement account binding is invalid")
	}
	if err := tx.Commit(); err != nil {
		return LedgerAccounts{}, err
	}
	return LedgerAccounts{DebitAccountID: uint64(debit), CreditAccountID: uint64(credit)}, nil
}

// PendingLedgerPoster is satisfied by ledger.PostingService and by
// reconciliation.GuardedLedger. The latter ensures every operation is checked
// against durable settlement fencing and receives an admission token.
type PendingLedgerPoster interface {
	PostPendingTransfer(context.Context, ledger.PostingRequest) (ledger.PostedTransferFact, error)
	CommitPendingTransfer(context.Context, ledger.PostingRequest) (ledger.PostedTransferFact, error)
	VoidPendingTransfer(context.Context, ledger.PostingRequest) (ledger.PostedTransferFact, error)
}

// TigerBeetleSagaLedger is the settlement.Ledger implementation. It derives
// unique deterministic IDs per operation and never accepts account IDs from an
// untrusted Intent. The caller must supply a guarded poster in production.
type TigerBeetleSagaLedger struct {
	Poster   PendingLedgerPoster
	Accounts AccountResolver
}

// LedgerObservation contains the three deterministic records that can exist
// for one saga: the pending transfer plus exactly one commit or void transfer.
type LedgerObservation struct {
	Pending   ledger.TransferObservation
	Committed ledger.TransferObservation
	Voided    ledger.TransferObservation
}

// Observe reads all deterministic TigerBeetle operation IDs. It rejects
// conflicting commit/void facts, account or amount mismatches, and a missing
// pending record rather than attempting to infer a safe settlement outcome.
func (l TigerBeetleSagaLedger) Observe(ctx context.Context, in Intent, pendingID uint64) (LedgerObservation, error) {
	if l.Poster == nil || l.Accounts == nil || pendingID == 0 {
		return LedgerObservation{}, errors.New("TigerBeetle poster, account resolver, and pending ID are required")
	}
	lookup, ok := l.Poster.(interface {
		LookupTransfer(context.Context, uint64) (ledger.TransferObservation, error)
	})
	if !ok {
		return LedgerObservation{}, errors.New("configured TigerBeetle poster does not support reconciliation lookup")
	}
	accounts, err := l.Accounts.ResolveSettlementAccounts(ctx, in)
	if err != nil {
		return LedgerObservation{}, err
	}
	pending, err := lookup.LookupTransfer(ctx, pendingID)
	if err != nil {
		return LedgerObservation{}, err
	}
	commitID := deterministicLedgerOperationID(in.TenantID, in.IdempotencyKey, intentPayloadDigest(in), "commit")
	voidID := deterministicLedgerOperationID(in.TenantID, in.IdempotencyKey, intentPayloadDigest(in), "void")
	committed, err := lookup.LookupTransfer(ctx, commitID)
	if err != nil {
		return LedgerObservation{}, err
	}
	voided, err := lookup.LookupTransfer(ctx, voidID)
	if err != nil {
		return LedgerObservation{}, err
	}
	if !pending.Exists || pending.ID != pendingID || pending.Mode != ledger.TransferPending || !strings.EqualFold(pending.Currency, in.Fiat) || pending.DebitAccountID != accounts.DebitAccountID || pending.CreditAccountID != accounts.CreditAccountID || pending.Amount != uint64(in.AmountMinor) {
		return LedgerObservation{}, errors.New("TigerBeetle pending transfer observation does not match durable saga")
	}
	if committed.Exists && (committed.Mode != ledger.TransferPostPending || committed.PendingID != pendingID || !strings.EqualFold(committed.Currency, in.Fiat) || committed.DebitAccountID != accounts.DebitAccountID || committed.CreditAccountID != accounts.CreditAccountID || committed.Amount != uint64(in.AmountMinor)) {
		return LedgerObservation{}, errors.New("TigerBeetle commit observation does not match durable saga")
	}
	if voided.Exists && (voided.Mode != ledger.TransferVoidPending || voided.PendingID != pendingID || !strings.EqualFold(voided.Currency, in.Fiat) || voided.DebitAccountID != accounts.DebitAccountID || voided.CreditAccountID != accounts.CreditAccountID || voided.Amount != uint64(in.AmountMinor)) {
		return LedgerObservation{}, errors.New("TigerBeetle void observation does not match durable saga")
	}
	if committed.Exists && voided.Exists {
		return LedgerObservation{}, errors.New("TigerBeetle saga has conflicting commit and void records")
	}
	return LedgerObservation{Pending: pending, Committed: committed, Voided: voided}, nil
}

func (l TigerBeetleSagaLedger) Prepare(ctx context.Context, in Intent) (LedgerFact, error) {
	request, err := l.postingRequest(ctx, in, "pending", 0)
	if err != nil {
		return LedgerFact{}, err
	}
	fact, err := l.Poster.PostPendingTransfer(ctx, request)
	if err != nil {
		return LedgerFact{}, fmt.Errorf("prepare TigerBeetle pending transfer: %w", err)
	}
	return ledgerFactFromPosted(fact, Prepared), nil
}
func (l TigerBeetleSagaLedger) Commit(ctx context.Context, in Intent, pending LedgerFact) (LedgerFact, error) {
	pendingID, err := ledgerFactID(pending)
	if err != nil {
		return LedgerFact{}, err
	}
	request, err := l.postingRequest(ctx, in, "commit", pendingID)
	if err != nil {
		return LedgerFact{}, err
	}
	fact, err := l.Poster.CommitPendingTransfer(ctx, request)
	if err != nil {
		return LedgerFact{}, fmt.Errorf("commit TigerBeetle pending transfer: %w", err)
	}
	return ledgerFactFromPosted(fact, Settled), nil
}
func (l TigerBeetleSagaLedger) Void(ctx context.Context, in Intent, pending LedgerFact, reason string) error {
	if strings.TrimSpace(reason) == "" {
		return errors.New("pending transfer void reason is required")
	}
	pendingID, err := ledgerFactID(pending)
	if err != nil {
		return err
	}
	request, err := l.postingRequest(ctx, in, "void", pendingID)
	if err != nil {
		return err
	}
	if _, err := l.Poster.VoidPendingTransfer(ctx, request); err != nil {
		return fmt.Errorf("void TigerBeetle pending transfer: %w", err)
	}
	return nil
}

func (l TigerBeetleSagaLedger) postingRequest(ctx context.Context, in Intent, operation string, pendingID uint64) (ledger.PostingRequest, error) {
	if err := validateIntent(in); err != nil {
		return ledger.PostingRequest{}, err
	}
	if l.Poster == nil || l.Accounts == nil {
		return ledger.PostingRequest{}, errors.New("TigerBeetle poster and tenant account resolver are required")
	}
	accounts, err := l.Accounts.ResolveSettlementAccounts(ctx, in)
	if err != nil {
		return ledger.PostingRequest{}, err
	}
	if in.AmountMinor <= 0 {
		return ledger.PostingRequest{}, ErrInvalidIntent
	}
	// intentPayloadDigest uses the raw payload for a new request and the
	// immutable persisted digest for recovery. Both paths must derive the same
	// operation ID; otherwise a timeout recovery could submit a second command.
	id := deterministicLedgerOperationID(in.TenantID, in.IdempotencyKey, intentPayloadDigest(in), operation)
	return ledger.PostingRequest{TransferID: id, CorrelationID: in.ID + ":" + operation, Currency: in.Fiat, Amount: uint64(in.AmountMinor), DebitAccountID: accounts.DebitAccountID, CreditAccountID: accounts.CreditAccountID, PendingID: pendingID}, nil
}

func deterministicLedgerOperationID(tenantID, idempotencyKey, payloadSHA256, operation string) uint64 {
	sum := sha256.Sum256([]byte(tenantID + "\x00" + idempotencyKey + "\x00" + payloadSHA256 + "\x00" + operation))
	id := binary.BigEndian.Uint64(sum[:8])
	// TigerBeetle IDs must be non-zero. The deterministic mapping retains the
	// remainder of the SHA-256 preimage and does not use a process-local counter.
	if id == 0 {
		return 1
	}
	return id
}

func ledgerFactFromPosted(fact ledger.PostedTransferFact, state State) LedgerFact {
	return LedgerFact{TransferID: strconv.FormatUint(fact.TransferID, 10), DebitAccount: strconv.FormatUint(fact.DebitAccountID, 10), CreditAccount: strconv.FormatUint(fact.CreditAccountID, 10), AmountMinor: int64(fact.Amount), Currency: fact.Currency, State: string(state)}
}
