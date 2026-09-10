package settlement

import (
	"context"
	"errors"
	"testing"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/ledger"
)

type sagaLedgerPoster struct {
	requests   []ledger.PostingRequest
	operations []string
	err        error
}

func (p *sagaLedgerPoster) PostPendingTransfer(_ context.Context, r ledger.PostingRequest) (ledger.PostedTransferFact, error) {
	p.requests = append(p.requests, r)
	p.operations = append(p.operations, "pending")
	if p.err != nil {
		return ledger.PostedTransferFact{}, p.err
	}
	return posted(r), nil
}
func (p *sagaLedgerPoster) CommitPendingTransfer(_ context.Context, r ledger.PostingRequest) (ledger.PostedTransferFact, error) {
	p.requests = append(p.requests, r)
	p.operations = append(p.operations, "commit")
	if p.err != nil {
		return ledger.PostedTransferFact{}, p.err
	}
	return posted(r), nil
}
func (p *sagaLedgerPoster) VoidPendingTransfer(_ context.Context, r ledger.PostingRequest) (ledger.PostedTransferFact, error) {
	p.requests = append(p.requests, r)
	p.operations = append(p.operations, "void")
	if p.err != nil {
		return ledger.PostedTransferFact{}, p.err
	}
	return posted(r), nil
}
func posted(r ledger.PostingRequest) ledger.PostedTransferFact {
	return ledger.PostedTransferFact{TransferID: r.TransferID, CorrelationID: r.CorrelationID, Currency: r.Currency, Amount: r.Amount, DebitAccountID: r.DebitAccountID, CreditAccountID: r.CreditAccountID}
}

type staticAccounts struct {
	accounts LedgerAccounts
	err      error
	intents  []Intent
}

func (r *staticAccounts) ResolveSettlementAccounts(_ context.Context, in Intent) (LedgerAccounts, error) {
	r.intents = append(r.intents, in)
	return r.accounts, r.err
}

func TestTigerBeetleSagaLedgerBindsPendingCommitAndVoidToTenantAccounts(t *testing.T) {
	poster := &sagaLedgerPoster{}
	accounts := &staticAccounts{accounts: LedgerAccounts{DebitAccountID: 10, CreditAccountID: 20}}
	adapter := TigerBeetleSagaLedger{Poster: poster, Accounts: accounts}
	in := validIntent()
	pending, err := adapter.Prepare(context.Background(), in)
	if err != nil || pending.State != string(Prepared) {
		t.Fatalf("pending=%+v err=%v", pending, err)
	}
	committed, err := adapter.Commit(context.Background(), in, pending)
	if err != nil || committed.State != string(Settled) {
		t.Fatalf("committed=%+v err=%v", committed, err)
	}
	if err := adapter.Void(context.Background(), in, pending, "provider proven no effect"); err != nil {
		t.Fatal(err)
	}
	if len(poster.requests) != 3 || poster.operations[0] != "pending" || poster.operations[1] != "commit" || poster.operations[2] != "void" {
		t.Fatalf("operations=%v requests=%+v", poster.operations, poster.requests)
	}
	if poster.requests[0].PendingID != 0 || poster.requests[1].PendingID != poster.requests[0].TransferID || poster.requests[2].PendingID != poster.requests[0].TransferID {
		t.Fatalf("pending bindings=%+v", poster.requests)
	}
	if poster.requests[0].DebitAccountID != 10 || poster.requests[0].CreditAccountID != 20 || len(accounts.intents) != 3 {
		t.Fatalf("accounts/request count=%+v/%d", poster.requests[0], len(accounts.intents))
	}
	if poster.requests[0].TransferID == poster.requests[1].TransferID || poster.requests[1].TransferID == poster.requests[2].TransferID {
		t.Fatalf("operation IDs must be distinct=%+v", poster.requests)
	}
}
func TestTigerBeetleSagaLedgerIDsAreDeterministicAndTenantBound(t *testing.T) {
	d := PayloadDigest([]byte("payload"))
	a := deterministicLedgerOperationID("tenant-a", "idem", d, "pending")
	if a != deterministicLedgerOperationID("tenant-a", "idem", d, "pending") || a == deterministicLedgerOperationID("tenant-b", "idem", d, "pending") || a == deterministicLedgerOperationID("tenant-a", "idem", d, "commit") {
		t.Fatal("operation ID must bind tenant, immutable key, digest, and operation")
	}
}
func TestTigerBeetleSagaLedgerFailsClosedWithoutGovernedDependencies(t *testing.T) {
	in := validIntent()
	if _, err := (TigerBeetleSagaLedger{}).Prepare(context.Background(), in); err == nil {
		t.Fatal("missing poster/resolver must fail")
	}
	adapter := TigerBeetleSagaLedger{Poster: &sagaLedgerPoster{}, Accounts: &staticAccounts{err: errors.New("binding unavailable")}}
	if _, err := adapter.Prepare(context.Background(), in); err == nil {
		t.Fatal("missing tenant binding must fail")
	}
}
