package settlement

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/ledger"
)

type unknownStoreFake struct {
	records        []SettlementRecord
	authorizations map[string]ResolutionAuthorization
	resolved       []string
}

func (s *unknownStoreFake) ClaimUnknownSagas(context.Context, string, string, int, time.Duration) ([]SettlementRecord, error) {
	return s.records, nil
}
func (s *unknownStoreFake) FindResolutionAuthorization(_ context.Context, tenant, saga, decision string) (ResolutionAuthorization, bool, error) {
	a, ok := s.authorizations[decision]
	return a, ok, nil
}
func (s *unknownStoreFake) ResolveUnknownSaga(_ context.Context, record SettlementRecord, owner string, auth ResolutionAuthorization, update SagaUpdate) (SettlementRecord, error) {
	if owner == "" || auth.TenantID != record.TenantID || auth.SagaID != record.SagaID {
		return SettlementRecord{}, ErrResolutionApproval
	}
	s.resolved = append(s.resolved, auth.Decision+":"+string(update.Reason))
	record.Stage = StageHeld
	if auth.Decision == "commit" {
		record.Stage = StageSettled
	}
	return record, nil
}

type recoveryFiat struct {
	result ProviderResult
	err    error
	calls  int
}

func (f *recoveryFiat) Quote(context.Context, Intent) (ProviderResult, error) {
	return ProviderResult{}, errors.New("unexpected")
}
func (f *recoveryFiat) Collect(context.Context, Intent) (ProviderResult, error) {
	return ProviderResult{}, errors.New("unexpected")
}
func (f *recoveryFiat) Payout(context.Context, Intent) (ProviderResult, error) {
	return ProviderResult{}, errors.New("unexpected")
}
func (f *recoveryFiat) Query(context.Context, Intent) (ProviderResult, error) {
	f.calls++
	return f.result, f.err
}
func (f *recoveryFiat) Refund(context.Context, Intent) (ProviderResult, error) {
	return ProviderResult{}, errors.New("unexpected")
}

type recoveryCustody struct {
	result ProviderResult
	err    error
	calls  int
}

func (c *recoveryCustody) SubmitTransfer(context.Context, Intent) (ProviderResult, error) {
	return ProviderResult{}, errors.New("unexpected")
}
func (c *recoveryCustody) QueryTransfer(context.Context, Intent) (ProviderResult, error) {
	c.calls++
	return c.result, c.err
}
func (c *recoveryCustody) Balance(context.Context, string, string) (int64, error) {
	return 0, errors.New("unexpected")
}

type recoveryFinality struct {
	final bool
	err   error
	calls int
}

func (f *recoveryFinality) Observe(context.Context, string, string) (ProviderResult, error) {
	return ProviderResult{}, errors.New("unexpected")
}
func (f *recoveryFinality) IsFinal(context.Context, string, string) (bool, error) {
	f.calls++
	return f.final, f.err
}

type recoveryLedger struct {
	observation                    LedgerObservation
	observeErr, commitErr, voidErr error
	commits, voids                 int
}

func (l *recoveryLedger) Prepare(context.Context, Intent) (LedgerFact, error) {
	return LedgerFact{}, errors.New("unexpected")
}
func (l *recoveryLedger) Observe(context.Context, Intent, uint64) (LedgerObservation, error) {
	return l.observation, l.observeErr
}
func (l *recoveryLedger) Commit(_ context.Context, in Intent, pending LedgerFact) (LedgerFact, error) {
	l.commits++
	if l.commitErr != nil {
		return LedgerFact{}, l.commitErr
	}
	return LedgerFact{TransferID: "22", DebitAccount: pending.DebitAccount, CreditAccount: pending.CreditAccount, AmountMinor: in.AmountMinor, Currency: in.Fiat, State: string(Settled)}, nil
}
func (l *recoveryLedger) Void(context.Context, Intent, LedgerFact, string) error {
	l.voids++
	return l.voidErr
}

type recoveryAttestor struct {
	digest string
	calls  int
}

func (a *recoveryAttestor) Attest(_ context.Context, _ Intent, digest string) (AttestationFact, error) {
	a.calls++
	a.digest = digest
	return AttestationFact{ID: "att-1", EvidenceID: "E-06", Digest: digest}, nil
}
func (a *recoveryAttestor) Verify(context.Context, AttestationFact) (bool, error) { return true, nil }

func unknownRecord() SettlementRecord {
	payload := []byte("recovery-payload")
	return SettlementRecord{TenantID: "tenant-a", SagaID: "saga-a", IntentID: "intent-a", IdempotencyKey: "idem-a", PayloadSHA256: PayloadDigest(payload), Direction: Onramp, Asset: "USDC", Fiat: "NGN", AmountMinor: 25, Destination: "wallet-a", Stage: StageUnknown, LedgerPendingID: 11, Version: 9}
}
func pendingObservation() LedgerObservation {
	return LedgerObservation{Pending: ledger.TransferObservation{ID: 11, DebitAccountID: 1, CreditAccountID: 2, Amount: 25, Currency: "NGN", Mode: ledger.TransferPending, Exists: true}}
}
func resolutionAuth(record SettlementRecord, decision string) ResolutionAuthorization {
	return ResolutionAuthorization{TenantID: record.TenantID, SagaID: record.SagaID, AuthorizationID: "auth-" + decision, Decision: decision, ReleaseSHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ManifestSHA256: PayloadDigest([]byte("manifest")), ReconciliationRunID: "reconcile-001", EvidenceSHA256: PayloadDigest([]byte("evidence")), ExpiresAt: time.Now().Add(time.Hour)}
}
func recoveryWorker(record SettlementRecord, store *unknownStoreFake, fiat *recoveryFiat, custody *recoveryCustody, finality *recoveryFinality, ledger *recoveryLedger, attestor *recoveryAttestor) UnknownSagaReconciler {
	return UnknownSagaReconciler{Store: store, Fiat: fiat, Custody: custody, Finality: finality, Ledger: ledger, Attestor: attestor, Owner: "worker-a", BatchSize: 10, Lease: time.Minute}
}

func TestUnknownSagaReconcilerLeavesSagaUnknownOnFinalityPartition(t *testing.T) {
	record := unknownRecord()
	store := &unknownStoreFake{records: []SettlementRecord{record}, authorizations: map[string]ResolutionAuthorization{"commit": resolutionAuth(record, "commit")}}
	fiat := &recoveryFiat{result: ProviderResult{State: Settled, Reference: "fiat-1"}}
	custody := &recoveryCustody{result: ProviderResult{State: Settled, Reference: "custody-1", BlockchainTx: "tx-1"}}
	finality := &recoveryFinality{err: context.DeadlineExceeded}
	led := &recoveryLedger{observation: pendingObservation()}
	att := &recoveryAttestor{}
	count, err := recoveryWorker(record, store, fiat, custody, finality, led, att).ReconcileOnce(context.Background(), record.TenantID)
	if err == nil || count != 0 || led.commits != 0 || led.voids != 0 || len(store.resolved) != 0 || att.calls != 0 {
		t.Fatalf("partition must remain UNKNOWN: count=%d err=%v commits=%d voids=%d resolutions=%v", count, err, led.commits, led.voids, store.resolved)
	}
}
func TestUnknownSagaReconcilerCommitsOnlyAfterConfirmedFactsAndAuthorization(t *testing.T) {
	record := unknownRecord()
	store := &unknownStoreFake{records: []SettlementRecord{record}, authorizations: map[string]ResolutionAuthorization{"commit": resolutionAuth(record, "commit")}}
	fiat := &recoveryFiat{result: ProviderResult{State: Settled, Reference: "fiat-1"}}
	custody := &recoveryCustody{result: ProviderResult{State: Settled, Reference: "custody-1", BlockchainTx: "tx-1"}}
	finality := &recoveryFinality{final: true}
	led := &recoveryLedger{observation: pendingObservation()}
	att := &recoveryAttestor{}
	count, err := recoveryWorker(record, store, fiat, custody, finality, led, att).ReconcileOnce(context.Background(), record.TenantID)
	if err != nil || count != 1 || led.commits != 1 || led.voids != 0 || len(store.resolved) != 1 || att.digest != record.PayloadSHA256 {
		t.Fatalf("confirmed approved outcome: count=%d err=%v commits=%d voids=%d resolved=%v digest=%s", count, err, led.commits, led.voids, store.resolved, att.digest)
	}
}
func TestUnknownSagaReconcilerVoidsOnlyWithNoEffectAndAuthorization(t *testing.T) {
	record := unknownRecord()
	store := &unknownStoreFake{records: []SettlementRecord{record}, authorizations: map[string]ResolutionAuthorization{"void": resolutionAuth(record, "void")}}
	failed := ProviderResult{State: Failed, RetryableWithoutEffect: true}
	fiat := &recoveryFiat{result: failed}
	custody := &recoveryCustody{result: failed}
	finality := &recoveryFinality{}
	led := &recoveryLedger{observation: pendingObservation()}
	att := &recoveryAttestor{}
	count, err := recoveryWorker(record, store, fiat, custody, finality, led, att).ReconcileOnce(context.Background(), record.TenantID)
	if err != nil || count != 1 || led.voids != 1 || led.commits != 0 || len(store.resolved) != 1 {
		t.Fatalf("no-effect void requires authorization: count=%d err=%v voids=%d resolutions=%v", count, err, led.voids, store.resolved)
	}
}
func TestUnknownSagaReconcilerRejectsMissingAuthorization(t *testing.T) {
	record := unknownRecord()
	store := &unknownStoreFake{records: []SettlementRecord{record}, authorizations: map[string]ResolutionAuthorization{}}
	fiat := &recoveryFiat{result: ProviderResult{State: Settled, Reference: "fiat-1"}}
	custody := &recoveryCustody{result: ProviderResult{State: Settled, Reference: "custody-1", BlockchainTx: "tx-1"}}
	finality := &recoveryFinality{final: true}
	led := &recoveryLedger{observation: pendingObservation()}
	att := &recoveryAttestor{}
	_, err := recoveryWorker(record, store, fiat, custody, finality, led, att).ReconcileOnce(context.Background(), record.TenantID)
	if !errors.Is(err, ErrResolutionApproval) || led.commits != 0 || len(store.resolved) != 0 {
		t.Fatalf("missing approval must block resolution: err=%v", err)
	}
}
