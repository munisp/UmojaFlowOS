package settlement

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/ledger"
)

var ErrReconciliationUnresolved = errors.New("UNKNOWN settlement saga remains unresolved")

// UnknownSagaLedger combines compensating command operations with verified
// observations of the deterministic pending, commit, and void transfers.
type UnknownSagaLedger interface {
	Ledger
	Observe(context.Context, Intent, uint64) (LedgerObservation, error)
}

// UnknownSagaReconciler is a bounded worker. It does not retry monetary
// operations on transport failure. Instead, it queries each authority and
// makes an approved terminal decision only when all facts agree.
type UnknownSagaReconciler struct {
	Store     UnknownSagaStore
	Fiat      FiatRail
	Custody   CustodyProvider
	Finality  FinalityProvider
	Ledger    UnknownSagaLedger
	Attestor  Attestor
	Owner     string
	BatchSize int
	Lease     time.Duration
}

func (w UnknownSagaReconciler) ReconcileOnce(ctx context.Context, tenantID string) (int, error) {
	if w.Store == nil || w.Fiat == nil || w.Custody == nil || w.Finality == nil || w.Ledger == nil || w.Attestor == nil || strings.TrimSpace(w.Owner) == "" || w.BatchSize <= 0 || w.Lease <= 0 {
		return 0, errors.New("reconciliation store, fiat, custody, finality, ledger, attestor, owner, batch size, and lease are required")
	}
	records, err := w.Store.ClaimUnknownSagas(ctx, tenantID, w.Owner, w.BatchSize, w.Lease)
	if err != nil {
		return 0, err
	}
	resolved := 0
	for _, record := range records {
		if err := w.reconcileRecord(ctx, record); err != nil {
			// Do not claim an unresolved or mismatched record is resolved. A caller
			// receives the count plus an error and can alert/continue safely.
			return resolved, err
		}
		resolved++
	}
	return resolved, nil
}

func (w UnknownSagaReconciler) reconcileRecord(ctx context.Context, record SettlementRecord) error {
	if record.Stage != StageUnknown || record.LedgerPendingID == 0 {
		return ErrReconciliationUnresolved
	}
	in := recoveryIntent(record)
	observation, err := w.Ledger.Observe(ctx, in, record.LedgerPendingID)
	if err != nil {
		return fmt.Errorf("observe TigerBeetle saga: %w", err)
	}
	if observation.Voided.Exists {
		return w.resolveHeld(ctx, record, in, observation, "pending ledger transfer was previously voided")
	}

	fiat, custody, final, effects, noEffect, err := w.observeCommercialEffects(ctx, in)
	if err != nil {
		return err
	}
	if noEffect && !observation.Committed.Exists {
		return w.voidAndHold(ctx, record, in, observation, "all provider queries prove no commercial effect")
	}
	if !effects || !final {
		return ErrReconciliationUnresolved
	}

	committedFact, err := w.ensureCommitted(ctx, record, in, observation)
	if err != nil {
		return err
	}
	return w.attestAndSettle(ctx, record, in, fiat, custody, committedFact)
}

func (w UnknownSagaReconciler) observeCommercialEffects(ctx context.Context, in Intent) (ProviderResult, ProviderResult, bool, bool, bool, error) {
	fiatStage := "fiat_collect"
	if in.Direction == Offramp {
		fiatStage = "fiat_payout"
	}
	custodyStage := "custody_onramp"
	if in.Direction == Offramp {
		custodyStage = "custody_offramp"
	}
	fiat, err := w.Fiat.Query(ctx, stageIntent(in, fiatStage))
	if err != nil {
		return ProviderResult{}, ProviderResult{}, false, false, false, fmt.Errorf("query fiat provider: %w", err)
	}
	custody, err := w.Custody.QueryTransfer(ctx, stageIntent(in, custodyStage))
	if err != nil {
		return ProviderResult{}, ProviderResult{}, false, false, false, fmt.Errorf("query custody provider: %w", err)
	}
	noEffect := fiat.State == Failed && fiat.RetryableWithoutEffect && custody.State == Failed && custody.RetryableWithoutEffect
	if !settledFact(fiat) || !settledFact(custody) || strings.TrimSpace(custody.BlockchainTx) == "" {
		return fiat, custody, false, false, noEffect, nil
	}
	final, err := w.Finality.IsFinal(ctx, custody.BlockchainTx, in.Asset)
	if err != nil {
		return fiat, custody, false, false, false, fmt.Errorf("query blockchain finality: %w", err)
	}
	return fiat, custody, final, true, false, nil
}

func (w UnknownSagaReconciler) ensureCommitted(ctx context.Context, record SettlementRecord, in Intent, observation LedgerObservation) (LedgerFact, error) {
	if observation.Committed.Exists {
		return ledgerFactFromObservation(observation.Committed, Settled), nil
	}
	auth, ok, err := w.Store.FindResolutionAuthorization(ctx, record.TenantID, record.SagaID, "commit")
	if err != nil {
		return LedgerFact{}, err
	}
	if !ok {
		return LedgerFact{}, ErrResolutionApproval
	}
	committed, err := w.Ledger.Commit(ctx, stageIntent(in, "ledger_commit"), ledgerFactFromObservation(observation.Pending, Prepared))
	if err != nil {
		return LedgerFact{}, fmt.Errorf("commit reconciled pending transfer: %w", err)
	}
	if err := validateLedgerFact(committed, in, Settled); err != nil {
		return LedgerFact{}, err
	}
	// Keep approval associated with a pending resolution. Resolution consumes it
	// only after attestation and cross-system reconciliation finish.
	_ = auth
	return committed, nil
}

func (w UnknownSagaReconciler) voidAndHold(ctx context.Context, record SettlementRecord, in Intent, observation LedgerObservation, reason string) error {
	auth, ok, err := w.Store.FindResolutionAuthorization(ctx, record.TenantID, record.SagaID, "void")
	if err != nil {
		return err
	}
	if !ok {
		return ErrResolutionApproval
	}
	if err := w.Ledger.Void(ctx, stageIntent(in, "ledger_void"), ledgerFactFromObservation(observation.Pending, Prepared), reason); err != nil {
		return fmt.Errorf("void reconciled pending transfer: %w", err)
	}
	_, err = w.Store.ResolveUnknownSaga(ctx, record, w.Owner, auth, SagaUpdate{FailureClass: "held", ReconciliationRunID: auth.ReconciliationRunID, Reason: reason})
	return err
}

func (w UnknownSagaReconciler) resolveHeld(ctx context.Context, record SettlementRecord, in Intent, observation LedgerObservation, reason string) error {
	auth, ok, err := w.Store.FindResolutionAuthorization(ctx, record.TenantID, record.SagaID, "void")
	if err != nil {
		return err
	}
	if !ok {
		return ErrResolutionApproval
	}
	_, err = w.Store.ResolveUnknownSaga(ctx, record, w.Owner, auth, SagaUpdate{FailureClass: "held", ReconciliationRunID: auth.ReconciliationRunID, Reason: reason})
	return err
}

func (w UnknownSagaReconciler) attestAndSettle(ctx context.Context, record SettlementRecord, in Intent, fiat, custody ProviderResult, committed LedgerFact) error {
	auth, ok, err := w.Store.FindResolutionAuthorization(ctx, record.TenantID, record.SagaID, "commit")
	if err != nil {
		return err
	}
	if !ok {
		return ErrResolutionApproval
	}
	digest := intentPayloadDigest(in)
	att, err := w.Attestor.Attest(ctx, stageIntent(in, "fabric_attest"), digest)
	if err != nil || att.Digest != digest || strings.TrimSpace(att.EvidenceID) == "" {
		if err == nil {
			err = ErrMismatch
		}
		return fmt.Errorf("reconcile attestation: %w", err)
	}
	verified, err := w.Attestor.Verify(ctx, att)
	if err != nil || !verified {
		if err == nil {
			err = ErrMismatch
		}
		return fmt.Errorf("verify reconciliation attestation: %w", err)
	}
	fiat.BlockchainTx = custody.BlockchainTx
	if err := Reconcile(committed, fiat, att, digest); err != nil {
		return err
	}
	_, err = w.Store.ResolveUnknownSaga(ctx, record, w.Owner, auth, SagaUpdate{ProviderReference: fiat.Reference, CustodyReference: custody.Reference, BlockchainTx: custody.BlockchainTx, LedgerTransferID: mustLedgerFactID(committed), AttestationID: att.ID, ReconciliationRunID: auth.ReconciliationRunID, Reason: "authorized post-partition reconciliation complete"})
	return err
}

func recoveryIntent(record SettlementRecord) Intent {
	return Intent{ID: record.IntentID, IdempotencyKey: record.IdempotencyKey, TenantID: record.TenantID, Asset: record.Asset, Fiat: record.Fiat, Destination: record.Destination, Direction: record.Direction, AmountMinor: record.AmountMinor, PayloadSHA256: record.PayloadSHA256}
}
func ledgerFactFromObservation(observation ledger.TransferObservation, state State) LedgerFact {
	return LedgerFact{TransferID: fmt.Sprintf("%d", observation.ID), DebitAccount: fmt.Sprintf("%d", observation.DebitAccountID), CreditAccount: fmt.Sprintf("%d", observation.CreditAccountID), AmountMinor: int64(observation.Amount), Currency: observation.Currency, State: string(state)}
}
func mustLedgerFactID(fact LedgerFact) uint64 { id, _ := ledgerFactID(fact); return id }
