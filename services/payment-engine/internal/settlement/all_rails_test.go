package settlement

import (
	"context"
	"errors"
	"testing"
	"time"
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
	prepared, committed            LedgerFact
	prepareErr, commitErr, voidErr error
	prepares, commits, voids       int
}

func (m *mockLedger) Prepare(context.Context, Intent) (LedgerFact, error) {
	m.prepares++
	if m.prepareErr != nil {
		return LedgerFact{}, m.prepareErr
	}
	return m.prepared, nil
}
func (m *mockLedger) Commit(context.Context, Intent, LedgerFact) (LedgerFact, error) {
	m.commits++
	if m.commitErr != nil {
		return LedgerFact{}, m.commitErr
	}
	return m.committed, nil
}
func (m *mockLedger) Void(context.Context, Intent, LedgerFact, string) error {
	m.voids++
	return m.voidErr
}
func (m *mockLedger) Query(context.Context, Intent) (LedgerFact, error) {
	return m.committed, m.commitErr
}

type mockFiat struct {
	collect, payout       ProviderResult
	collectErr, payoutErr error
	calls                 []string
}

func (m *mockFiat) Quote(context.Context, Intent) (ProviderResult, error) {
	return ProviderResult{}, nil
}
func (m *mockFiat) Collect(_ context.Context, in Intent) (ProviderResult, error) {
	m.calls = append(m.calls, in.IdempotencyKey)
	return m.collect, m.collectErr
}
func (m *mockFiat) Payout(_ context.Context, in Intent) (ProviderResult, error) {
	m.calls = append(m.calls, in.IdempotencyKey)
	return m.payout, m.payoutErr
}
func (m *mockFiat) Query(context.Context, Intent) (ProviderResult, error) {
	return ProviderResult{}, nil
}
func (m *mockFiat) Refund(context.Context, Intent) (ProviderResult, error) {
	return ProviderResult{}, nil
}

type mockCustody struct {
	result ProviderResult
	err    error
	calls  []string
}

func (m *mockCustody) SubmitTransfer(_ context.Context, in Intent) (ProviderResult, error) {
	m.calls = append(m.calls, in.IdempotencyKey)
	return m.result, m.err
}
func (m *mockCustody) QueryTransfer(context.Context, Intent) (ProviderResult, error) {
	return m.result, m.err
}
func (m *mockCustody) Balance(context.Context, string, string) (int64, error) { return 0, nil }

type mockFinality struct {
	final bool
	err   error
	calls []string
}

func (m *mockFinality) Observe(context.Context, string, string) (ProviderResult, error) {
	return ProviderResult{}, nil
}
func (m *mockFinality) IsFinal(_ context.Context, tx, asset string) (bool, error) {
	m.calls = append(m.calls, tx+":"+asset)
	return m.final, m.err
}

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

type mockSaga struct {
	record                          SettlementRecord
	owned                           bool
	reserveErr                      error
	advanceErr, heldErr, unknownErr error
	stages                          []ExecutionStage
	reserves                        int
}

func newMockSaga(in Intent) *mockSaga {
	return &mockSaga{owned: true, record: SettlementRecord{TenantID: in.TenantID, SagaID: "saga-1", IntentID: in.ID, IdempotencyKey: in.IdempotencyKey, PayloadSHA256: PayloadDigest(in.Payload), Direction: in.Direction, Stage: StageReceived, Version: 1}}
}
func (m *mockSaga) Reserve(context.Context, Intent, string) (SettlementRecord, bool, error) {
	m.reserves++
	return m.record, m.owned, m.reserveErr
}
func (m *mockSaga) Advance(_ context.Context, current SettlementRecord, next ExecutionStage, update SagaUpdate) (SettlementRecord, error) {
	if m.advanceErr != nil {
		return SettlementRecord{}, m.advanceErr
	}
	if current.Stage != m.record.Stage || current.Version != m.record.Version || !stageAllowsRecord(current, next) {
		return SettlementRecord{}, ErrSagaConflict
	}
	m.record = recordWithUpdate(current, next, update, time.Now().UTC())
	m.stages = append(m.stages, next)
	return m.record, nil
}
func (m *mockSaga) MarkHeld(_ context.Context, record SettlementRecord, reason string) error {
	if m.heldErr != nil {
		return m.heldErr
	}
	m.record = recordWithUpdate(record, StageHeld, SagaUpdate{FailureClass: reason}, time.Now().UTC())
	m.stages = append(m.stages, StageHeld)
	return nil
}
func (m *mockSaga) MarkUnknown(_ context.Context, record SettlementRecord, reason string) error {
	if m.unknownErr != nil {
		return m.unknownErr
	}
	m.record = recordWithUpdate(record, StageUnknown, SagaUpdate{FailureClass: reason}, time.Now().UTC())
	m.stages = append(m.stages, StageUnknown)
	return nil
}
func (m *mockSaga) Load(context.Context, string, string) (SettlementRecord, error) {
	return m.record, nil
}

func validIntent() Intent {
	return Intent{ID: "intent-1", IdempotencyKey: "idem-1", TenantID: "tenant-a", Asset: "USDC", Fiat: "NGN", Destination: "wallet-1", DestinationCountry: "NG", Direction: Onramp, AmountMinor: 1000, Payload: []byte(`{"asset":"USDC","fiat":"NGN","amount":1000}`)}
}
func testRoutingAndLiquidity() (CorridorRouter, LiquidityVerifier) {
	route := CorridorRoute{ID: "ng-onramp", TenantID: "tenant-a", OriginCountry: "US", DestinationCountry: "NG", SourceCurrency: "NGN", Direction: Onramp, Asset: "USDC", Rails: []string{"mojaloop"}, ProviderPriority: []string{"bank-primary"}, MinAmountMinor: 1, MaxAmountMinor: 1000000, QuoteTTL: time.Hour, Enabled: true}
	return StaticCorridorRouter{Routes: []CorridorRoute{route}}, StaticLiquidityVerifier{Evidence: LiquidityEvidence{AvailableMinor: 100000, ReservedMinor: 0, RequiredBufferMinor: 1000, ObservedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour)}}
}
func preparedFact() LedgerFact {
	return LedgerFact{TransferID: "101", DebitAccount: "a", CreditAccount: "b", AmountMinor: 1000, Currency: "NGN", State: string(Prepared)}
}
func committedFact() LedgerFact {
	return LedgerFact{TransferID: "102", DebitAccount: "a", CreditAccount: "b", AmountMinor: 1000, Currency: "NGN", State: string(Settled)}
}

func coordinatorWith(in Intent, l *mockLedger, a *mockAttestor, decision string) (*Coordinator, *mockSaga, *mockFiat, *mockCustody, *mockFinality) {
	routing, liquidity := testRoutingAndLiquidity()
	saga := newMockSaga(in)
	fiat := &mockFiat{collect: ProviderResult{State: Settled, Reference: "fiat-1"}, payout: ProviderResult{State: Settled, Reference: "payout-1"}}
	custody := &mockCustody{result: ProviderResult{State: Settled, Reference: "custody-1", BlockchainTx: "chain-1"}}
	finality := &mockFinality{final: true}
	return &Coordinator{Fiat: fiat, Custody: custody, Finality: finality, Screening: mockScreen{decision: decision}, Ledger: l, Attestor: a, Routing: routing, Liquidity: liquidity, Saga: saga}, saga, fiat, custody, finality
}

func TestCoordinatorOnrampSettlesOnlyAfterAllIndependentFacts(t *testing.T) {
	in := validIntent()
	l := &mockLedger{prepared: preparedFact(), committed: committedFact()}
	a := &mockAttestor{fact: AttestationFact{ID: "fab-1", EvidenceID: "E-06", Digest: PayloadDigest(in.Payload)}, verified: true}
	c, saga, fiat, custody, finality := coordinatorWith(in, l, a, "clear")
	out, err := c.Execute(context.Background(), in)
	if err != nil || out.State != Settled {
		t.Fatalf("out=%+v err=%v", out, err)
	}
	if l.prepares != 1 || l.commits != 1 || a.calls != 1 || len(fiat.calls) != 1 || len(custody.calls) != 1 || len(finality.calls) != 1 {
		t.Fatalf("missing required side effect: ledger=%d/%d attestation=%d fiat=%v custody=%v finality=%v", l.prepares, l.commits, a.calls, fiat.calls, custody.calls, finality.calls)
	}
	if fiat.calls[0] != "idem-1:fiat_collect" || custody.calls[0] != "idem-1:custody_onramp" {
		t.Fatalf("stage idempotency keys=%v/%v", fiat.calls, custody.calls)
	}
	if saga.record.Stage != StageSettled || len(saga.stages) != 10 {
		t.Fatalf("stage=%s transitions=%v", saga.record.Stage, saga.stages)
	}
}
func TestCoordinatorOfframpFinalizesCustodyBeforePayout(t *testing.T) {
	in := validIntent()
	in.Direction = Offramp
	l := &mockLedger{prepared: preparedFact(), committed: committedFact()}
	a := &mockAttestor{fact: AttestationFact{ID: "fab-1", EvidenceID: "E-06", Digest: PayloadDigest(in.Payload)}, verified: true}
	c, saga, fiat, custody, finality := coordinatorWith(in, l, a, "clear")
	c.Routing = StaticCorridorRouter{Routes: []CorridorRoute{{ID: "ng-offramp", TenantID: "tenant-a", OriginCountry: "US", DestinationCountry: "NG", SourceCurrency: "NGN", Direction: Offramp, Asset: "USDC", Rails: []string{"bank"}, ProviderPriority: []string{"bank-primary"}, MinAmountMinor: 1, MaxAmountMinor: 1000000, QuoteTTL: time.Hour, Enabled: true}}}
	out, err := c.Execute(context.Background(), in)
	if err != nil || out.State != Settled || len(custody.calls) != 1 || len(finality.calls) != 1 || len(fiat.calls) != 1 || fiat.calls[0] != "idem-1:fiat_payout" {
		t.Fatalf("out=%+v err=%v custody=%v finality=%v fiat=%v", out, err, custody.calls, finality.calls, fiat.calls)
	}
	if saga.record.Stage != StageSettled || l.commits != 1 {
		t.Fatalf("stage=%s commits=%d", saga.record.Stage, l.commits)
	}
}
func TestCoordinatorHoldsWhenScreeningNotClear(t *testing.T) {
	in := validIntent()
	l := &mockLedger{}
	a := &mockAttestor{}
	c, saga, fiat, custody, _ := coordinatorWith(in, l, a, "review")
	out, err := c.Execute(context.Background(), in)
	if !errors.Is(err, ErrHeld) || out.State != Held || l.prepares != 0 || len(fiat.calls) != 0 || len(custody.calls) != 0 || saga.record.Stage != StageHeld {
		t.Fatalf("out=%+v err=%v", out, err)
	}
}
func TestCoordinatorMarksUnknownWhenLedgerPrepareFails(t *testing.T) {
	in := validIntent()
	l := &mockLedger{prepareErr: errors.New("ledger unavailable")}
	a := &mockAttestor{}
	c, saga, _, _, _ := coordinatorWith(in, l, a, "clear")
	out, err := c.Execute(context.Background(), in)
	if !errors.Is(err, ErrUnknown) || out.State != Unknown || a.calls != 0 || saga.record.Stage != StageUnknown {
		t.Fatalf("out=%+v err=%v calls=%d stage=%s", out, err, a.calls, saga.record.Stage)
	}
}
func TestCoordinatorVoidsPendingOnlyOnProvenNoEffect(t *testing.T) {
	in := validIntent()
	l := &mockLedger{prepared: preparedFact(), committed: committedFact()}
	a := &mockAttestor{}
	c, saga, fiat, _, _ := coordinatorWith(in, l, a, "clear")
	fiat.collect = ProviderResult{State: Failed, RetryableWithoutEffect: true}
	out, err := c.Execute(context.Background(), in)
	if !errors.Is(err, ErrHeld) || out.State != Held || l.voids != 1 || l.commits != 0 || saga.record.Stage != StageHeld {
		t.Fatalf("out=%+v err=%v voids=%d commits=%d stage=%s", out, err, l.voids, l.commits, saga.record.Stage)
	}
}
func TestCoordinatorDoesNotVoidAfterAmbiguousFiatEffect(t *testing.T) {
	in := validIntent()
	l := &mockLedger{prepared: preparedFact()}
	a := &mockAttestor{}
	c, saga, fiat, _, _ := coordinatorWith(in, l, a, "clear")
	fiat.collectErr = errors.New("timeout")
	out, err := c.Execute(context.Background(), in)
	if !errors.Is(err, ErrUnknown) || out.State != Unknown || l.voids != 0 || saga.record.Stage != StageUnknown {
		t.Fatalf("out=%+v err=%v voids=%d stage=%s", out, err, l.voids, saga.record.Stage)
	}
}
func TestCoordinatorRejectsByzantineAttestation(t *testing.T) {
	in := validIntent()
	l := &mockLedger{prepared: preparedFact(), committed: committedFact()}
	a := &mockAttestor{fact: AttestationFact{ID: "fab-1", EvidenceID: "E-06", Digest: PayloadDigest([]byte("wrong"))}, verified: true}
	c, saga, _, _, _ := coordinatorWith(in, l, a, "clear")
	out, err := c.Execute(context.Background(), in)
	if !errors.Is(err, ErrUnknown) || out.State != Unknown || saga.record.Stage != StageUnknown {
		t.Fatalf("out=%+v err=%v", out, err)
	}
}
func TestCoordinatorHoldsWhenRouteUnavailable(t *testing.T) {
	in := validIntent()
	l := &mockLedger{}
	a := &mockAttestor{}
	c, saga, _, _, _ := coordinatorWith(in, l, a, "clear")
	c.Routing = StaticCorridorRouter{}
	out, err := c.Execute(context.Background(), in)
	if !errors.Is(err, ErrCorridorUnavailable) || out.State != Held || l.prepares != 0 || saga.record.Stage != StageHeld {
		t.Fatalf("out=%+v err=%v", out, err)
	}
}
func TestCoordinatorHoldsWhenLiquidityInsufficient(t *testing.T) {
	in := validIntent()
	l := &mockLedger{}
	a := &mockAttestor{}
	c, saga, _, _, _ := coordinatorWith(in, l, a, "clear")
	c.Liquidity = StaticLiquidityVerifier{Evidence: LiquidityEvidence{AvailableMinor: 1000, RequiredBufferMinor: 1000, ObservedAt: time.Now(), ExpiresAt: time.Now().Add(time.Hour)}}
	out, err := c.Execute(context.Background(), in)
	if !errors.Is(err, ErrLiquidityInsufficient) || out.State != Held || l.prepares != 0 || saga.record.Stage != StageHeld {
		t.Fatalf("out=%+v err=%v", out, err)
	}
}
func TestCoordinatorReturnsDurableResultWithoutRepeatingEffects(t *testing.T) {
	in := validIntent()
	l := &mockLedger{}
	a := &mockAttestor{}
	c, saga, fiat, custody, _ := coordinatorWith(in, l, a, "clear")
	saga.owned = false
	saga.record.Stage = StageSettled
	saga.record.ProviderReference = "fiat-1"
	out, err := c.Execute(context.Background(), in)
	if err != nil || out.State != Settled || l.prepares != 0 || len(fiat.calls) != 0 || len(custody.calls) != 0 {
		t.Fatalf("out=%+v err=%v", out, err)
	}
}
func TestCoordinatorRequiresAllDependencies(t *testing.T) {
	in := validIntent()
	l := &mockLedger{}
	a := &mockAttestor{}
	c := &Coordinator{Screening: mockScreen{decision: "clear"}, Ledger: l, Attestor: a}
	out, err := c.Execute(context.Background(), in)
	if err == nil || out.State != "" || l.prepares != 0 {
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
