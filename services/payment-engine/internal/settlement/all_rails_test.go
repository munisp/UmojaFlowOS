package settlement

import (
	"context"
	"errors"
	"testing"
)

type mockScreen struct {
	decision string
	err      error
}

func (m mockScreen) Screen(context.Context, Intent) (ScreenResult, error) {
	if m.err != nil {
		return ScreenResult{}, m.err
	}
	return ScreenResult{Decision: m.decision, CaseID: "case-1", Reason: "policy"}, nil
}

type mockLedger struct {
	fact  LedgerFact
	err   error
	posts int
}

func (m *mockLedger) Post(context.Context, Intent) (LedgerFact, error) {
	m.posts++
	if m.err != nil {
		return LedgerFact{}, m.err
	}
	return m.fact, nil
}
func (m *mockLedger) Query(context.Context, Intent) (LedgerFact, error) { return m.fact, m.err }

type mockAttestor struct {
	fact     AttestationFact
	err      error
	verified bool
	calls    int
}

func (m *mockAttestor) Attest(context.Context, Intent, string) (AttestationFact, error) {
	m.calls++
	if m.err != nil {
		return AttestationFact{}, m.err
	}
	return m.fact, nil
}
func (m *mockAttestor) Verify(context.Context, AttestationFact) (bool, error) { return m.verified, nil }

func validIntent() Intent {
	return Intent{ID: "intent-1", IdempotencyKey: "idem-1", TenantID: "tenant-a", Asset: "USDC", Fiat: "NGN", Destination: "wallet-1", Direction: Onramp, AmountMinor: 1000, Payload: []byte(`{"asset":"USDC","fiat":"NGN","amount":1000}`)}
}
func TestCoordinatorSettlesOnlyAfterLedgerAndFabricVerification(t *testing.T) {
	in := validIntent()
	l := &mockLedger{fact: LedgerFact{TransferID: "tb-1", DebitAccount: "a", CreditAccount: "b", AmountMinor: 1000, Currency: "NGN", State: string(Settled)}}
	a := &mockAttestor{fact: AttestationFact{ID: "fab-1", EvidenceID: "E-06", Digest: PayloadDigest(in.Payload)}, verified: true}
	c := Coordinator{Screening: mockScreen{decision: "clear"}, Ledger: l, Attestor: a}
	out, err := c.Execute(context.Background(), in)
	if err != nil || out.State != Settled {
		t.Fatalf("out=%+v err=%v", out, err)
	}
	if l.posts != 1 || a.calls != 1 {
		t.Fatalf("posts=%d attests=%d", l.posts, a.calls)
	}
}
func TestCoordinatorHoldsWhenScreeningNotClear(t *testing.T) {
	l := &mockLedger{}
	a := &mockAttestor{}
	c := Coordinator{Screening: mockScreen{decision: "review"}, Ledger: l, Attestor: a}
	out, err := c.Execute(context.Background(), validIntent())
	if err == nil || out.State != Held || l.posts != 0 || a.calls != 0 {
		t.Fatalf("out=%+v err=%v posts=%d calls=%d", out, err, l.posts, a.calls)
	}
}
func TestCoordinatorHoldsOnLedgerFailure(t *testing.T) {
	l := &mockLedger{err: errors.New("ledger unavailable")}
	a := &mockAttestor{}
	c := Coordinator{Screening: mockScreen{decision: "clear"}, Ledger: l, Attestor: a}
	out, err := c.Execute(context.Background(), validIntent())
	if !errors.Is(err, ErrUnknown) || out.State != Unknown || a.calls != 0 {
		t.Fatalf("out=%+v err=%v calls=%d", out, err, a.calls)
	}
}
func TestCoordinatorRejectsByzantineAttestation(t *testing.T) {
	in := validIntent()
	l := &mockLedger{fact: LedgerFact{TransferID: "tb-1", DebitAccount: "a", CreditAccount: "b", AmountMinor: 1000, Currency: "NGN", State: string(Settled)}}
	a := &mockAttestor{fact: AttestationFact{ID: "fab-1", EvidenceID: "E-06", Digest: PayloadDigest([]byte("wrong"))}, verified: true}
	c := Coordinator{Screening: mockScreen{decision: "clear"}, Ledger: l, Attestor: a}
	out, err := c.Execute(context.Background(), in)
	if !errors.Is(err, ErrMismatch) || out.State != Held {
		t.Fatalf("out=%+v err=%v", out, err)
	}
}
func TestCoordinatorRejectsMissingTenantAndInvalidDirection(t *testing.T) {
	in := validIntent()
	in.TenantID = ""
	if err := validateIntent(in); !errors.Is(err, ErrInvalidIntent) {
		t.Fatal(err)
	}
	in = validIntent()
	in.Direction = "invalid"
	if err := validateIntent(in); !errors.Is(err, ErrInvalidIntent) {
		t.Fatal(err)
	}
}
func TestReconcileRequiresAllBoundFacts(t *testing.T) {
	if err := Reconcile(LedgerFact{State: string(Settled)}, ProviderResult{State: Settled, Reference: "p"}, AttestationFact{ID: "a", Digest: "d"}, "wrong"); !errors.Is(err, ErrMismatch) {
		t.Fatal(err)
	}
	if err := Reconcile(LedgerFact{State: string(Settled)}, ProviderResult{State: Settled, Reference: "p"}, AttestationFact{ID: "a", Digest: "d"}, "d"); err != nil {
		t.Fatal(err)
	}
}
