package settlement

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type Direction string

const (
	Onramp  Direction = "onramp"
	Offramp Direction = "offramp"
)

type State string

const (
	Prepared  State = "prepared"
	Held      State = "held"
	Unknown   State = "unknown"
	Submitted State = "submitted"
	Settled   State = "settled"
	Failed    State = "failed"
)

type Intent struct {
	ID, IdempotencyKey, TenantID, Asset, Fiat, Destination string
	OriginCountry, DestinationCountry, CorridorID          string
	PreferredRail                                          string
	Direction                                              Direction
	AmountMinor                                            int64
	Payload                                                []byte
	ExpiresAt                                              time.Time
}
type ProviderResult struct {
	Reference, BlockchainTx, Reason string
	State                           State
	RetryableWithoutEffect          bool
}
type ScreenResult struct {
	Decision       string
	CaseID, Reason string
}
type LedgerFact struct {
	TransferID, DebitAccount, CreditAccount string
	AmountMinor                             int64
	Currency, State                         string
}
type AttestationFact struct{ ID, ReleaseSHA, EvidenceID, Digest string }

var (
	ErrInvalidIntent = errors.New("invalid settlement intent")
	ErrUnknown       = errors.New("settlement outcome is unknown; retry prohibited")
	ErrHeld          = errors.New("settlement held pending a new authorized instruction or manual resolution")
	ErrMismatch      = errors.New("cross-system settlement facts mismatch")
)

// FiatRail represents a regulated bank/PSP/IMTO boundary. Every command must
// use a deterministic stage-specific idempotency key and Query must be able to
// determine the effect of a timed-out request.
type FiatRail interface {
	Quote(context.Context, Intent) (ProviderResult, error)
	Collect(context.Context, Intent) (ProviderResult, error)
	Payout(context.Context, Intent) (ProviderResult, error)
	Query(context.Context, Intent) (ProviderResult, error)
	Refund(context.Context, Intent) (ProviderResult, error)
}
type CustodyProvider interface {
	SubmitTransfer(context.Context, Intent) (ProviderResult, error)
	QueryTransfer(context.Context, Intent) (ProviderResult, error)
	Balance(context.Context, string, string) (int64, error)
}
type FinalityProvider interface {
	Observe(context.Context, string, string) (ProviderResult, error)
	IsFinal(context.Context, string, string) (bool, error)
}
type ScreeningProvider interface {
	Screen(context.Context, Intent) (ScreenResult, error)
}

// Ledger is a compensatable accounting boundary. A coordinator must never call
// a final posting operation before it can durably associate every external
// commercial effect with the same tenant, intent, payload digest, and saga.
type Ledger interface {
	Prepare(context.Context, Intent) (LedgerFact, error)
	Commit(context.Context, Intent, LedgerFact) (LedgerFact, error)
	Void(context.Context, Intent, LedgerFact, string) error
}
type Attestor interface {
	Attest(context.Context, Intent, string) (AttestationFact, error)
	Verify(context.Context, AttestationFact) (bool, error)
}

type Coordinator struct {
	Fiat      FiatRail
	Custody   CustodyProvider
	Finality  FinalityProvider
	Screening ScreeningProvider
	Ledger    Ledger
	Attestor  Attestor
	Routing   CorridorRouter
	Liquidity LiquidityVerifier
	Saga      SagaStore
}

// Execute is intentionally a durable saga, not a distributed transaction. A
// caller receives SETTLED only when the persisted saga has verified all
// independent facts. Once any commercial effect may have happened, failures
// are UNKNOWN and callers must reconcile rather than issue a new command.
func (c *Coordinator) Execute(ctx context.Context, in Intent) (ProviderResult, error) {
	if err := validateIntent(in); err != nil {
		return ProviderResult{}, err
	}
	if c.Fiat == nil || c.Custody == nil || c.Finality == nil || c.Screening == nil || c.Ledger == nil || c.Attestor == nil || c.Routing == nil || c.Liquidity == nil || c.Saga == nil {
		return ProviderResult{}, errors.New("fiat, custody, finality, screening, ledger, attestor, routing, liquidity verifier, and saga store are required")
	}
	digest := PayloadDigest(in.Payload)
	record, owned, err := c.Saga.Reserve(ctx, in, digest)
	if err != nil {
		return ProviderResult{State: Unknown, Reason: "durable idempotency unavailable"}, fmt.Errorf("%w: %v", ErrUnknown, err)
	}
	if !owned {
		return resultFromRecord(record)
	}
	return c.executeOwned(ctx, in, record, digest)
}

func (c *Coordinator) executeOwned(ctx context.Context, in Intent, record SettlementRecord, digest string) (ProviderResult, error) {
	screen, err := c.Screening.Screen(ctx, stageIntent(in, "screen"))
	if err != nil {
		return c.hold(ctx, record, "screening unavailable", err)
	}
	if !strings.EqualFold(screen.Decision, "clear") {
		return c.hold(ctx, record, "screening denied: "+boundedReason(screen.Reason), ErrHeld)
	}
	record, err = c.advance(ctx, record, StageScreened, SagaUpdate{Reason: "screening clear"})
	if err != nil {
		return c.unknown(ctx, record, "could not persist screening result", err)
	}

	route, err := c.Routing.Route(ctx, in)
	if err != nil {
		return c.hold(ctx, record, "corridor route unavailable", ErrCorridorUnavailable)
	}
	record, err = c.advance(ctx, record, StageRouted, SagaUpdate{RouteID: route.Route.ID, Reason: "route selected"})
	if err != nil {
		return c.unknown(ctx, record, "could not persist route", err)
	}

	liquidity, err := c.Liquidity.Verify(ctx, in, route)
	if err != nil || !liquidity.Allowed {
		if err == nil {
			err = ErrLiquidityUnavailable
		}
		return c.hold(ctx, record, "liquidity unavailable: "+boundedReason(liquidity.Reason), err)
	}
	record, err = c.advance(ctx, record, StageLiquidityReserved, SagaUpdate{Reason: "liquidity admission granted"})
	if err != nil {
		return c.unknown(ctx, record, "could not persist liquidity admission", err)
	}

	pending, err := c.Ledger.Prepare(ctx, stageIntent(in, "ledger_prepare"))
	if err != nil {
		return c.unknown(ctx, record, "ledger prepare outcome unknown", err)
	}
	if err := validateLedgerFact(pending, in, Prepared); err != nil {
		return c.unknown(ctx, record, "prepared ledger fact mismatch", err)
	}
	pendingID, err := ledgerFactID(pending)
	if err != nil {
		return c.unknown(ctx, record, "prepared ledger identifier invalid", err)
	}
	record, err = c.advance(ctx, record, StageLedgerPrepared, SagaUpdate{LedgerPendingID: pendingID, Reason: "ledger pending transfer prepared"})
	if err != nil {
		return c.unknown(ctx, record, "could not persist pending ledger fact", err)
	}

	var providerOutcome ProviderResult
	if in.Direction == Onramp {
		providerOutcome, record, err = c.executeOnrampEffects(ctx, in, record, pending)
	} else {
		providerOutcome, record, err = c.executeOfframpEffects(ctx, in, record, pending)
	}
	if err != nil {
		return providerOutcome, err
	}

	committed, err := c.Ledger.Commit(ctx, stageIntent(in, "ledger_commit"), pending)
	if err != nil {
		return c.unknown(ctx, record, "ledger commit outcome unknown", err)
	}
	if err := validateLedgerFact(committed, in, Settled); err != nil {
		return c.unknown(ctx, record, "committed ledger fact mismatch", err)
	}
	transferID, err := ledgerFactID(committed)
	if err != nil {
		return c.unknown(ctx, record, "committed ledger identifier invalid", err)
	}
	record, err = c.advance(ctx, record, StageLedgerCommitted, SagaUpdate{LedgerTransferID: transferID, Reason: "ledger pending transfer committed"})
	if err != nil {
		return c.unknown(ctx, record, "could not persist committed ledger fact", err)
	}

	att, err := c.Attestor.Attest(ctx, stageIntent(in, "fabric_attest"), digest)
	if err != nil || att.Digest != digest || strings.TrimSpace(att.EvidenceID) == "" {
		if err == nil {
			err = ErrMismatch
		}
		return c.unknown(ctx, record, "attestation outcome unknown or mismatched", err)
	}
	verified, err := c.Attestor.Verify(ctx, att)
	if err != nil || !verified {
		if err == nil {
			err = ErrMismatch
		}
		return c.unknown(ctx, record, "attestation verification failed", err)
	}
	record, err = c.advance(ctx, record, StageAttestationVerified, SagaUpdate{AttestationID: att.ID, Reason: "attestation verified"})
	if err != nil {
		return c.unknown(ctx, record, "could not persist verified attestation", err)
	}

	if err := Reconcile(committed, providerOutcome, att, digest); err != nil {
		return c.unknown(ctx, record, "cross-system reconciliation mismatch", err)
	}
	record, err = c.advance(ctx, record, StageSettled, SagaUpdate{ProviderReference: providerOutcome.Reference, AttestationID: att.ID, Reason: "all settlement facts reconciled"})
	if err != nil {
		return c.unknown(ctx, record, "could not persist settled outcome", err)
	}
	return ProviderResult{State: Settled, Reference: providerOutcome.Reference, BlockchainTx: providerOutcome.BlockchainTx, Reason: "fiat, custody, finality, ledger, and attestation facts reconciled"}, nil
}

func (c *Coordinator) executeOnrampEffects(ctx context.Context, in Intent, record SettlementRecord, pending LedgerFact) (ProviderResult, SettlementRecord, error) {
	fiat, err := c.Fiat.Collect(ctx, stageIntent(in, "fiat_collect"))
	if err != nil || !settledFact(fiat) {
		return c.handlePreCustodyFailure(ctx, in, record, pending, fiat, "fiat collection", err)
	}
	record, err = c.advance(ctx, record, StageFiatSubmitted, SagaUpdate{ProviderReference: fiat.Reference, Reason: "fiat collection confirmed"})
	if err != nil {
		result, unknownErr := c.unknown(ctx, record, "could not persist fiat collection", err)
		return result, record, unknownErr
	}
	custody, err := c.Custody.SubmitTransfer(ctx, stageIntent(in, "custody_onramp"))
	if err != nil || !settledFact(custody) || strings.TrimSpace(custody.BlockchainTx) == "" {
		result, unknownErr := c.unknown(ctx, record, "custody onramp outcome unknown", errOrMismatch(err))
		return result, record, unknownErr
	}
	record, err = c.advance(ctx, record, StageCustodySubmitted, SagaUpdate{CustodyReference: custody.Reference, BlockchainTx: custody.BlockchainTx, Reason: "custody transfer submitted"})
	if err != nil {
		result, unknownErr := c.unknown(ctx, record, "could not persist custody transfer", err)
		return result, record, unknownErr
	}
	final, err := c.Finality.IsFinal(ctx, custody.BlockchainTx, in.Asset)
	if err != nil || !final {
		result, unknownErr := c.unknown(ctx, record, "custody transfer finality unknown", errOrMismatch(err))
		return result, record, unknownErr
	}
	record, err = c.advance(ctx, record, StageFinalityConfirmed, SagaUpdate{Reason: "custody transfer finality confirmed"})
	if err != nil {
		result, unknownErr := c.unknown(ctx, record, "could not persist custody finality", err)
		return result, record, unknownErr
	}
	fiat.BlockchainTx = custody.BlockchainTx
	return fiat, record, nil
}

func (c *Coordinator) executeOfframpEffects(ctx context.Context, in Intent, record SettlementRecord, pending LedgerFact) (ProviderResult, SettlementRecord, error) {
	custody, err := c.Custody.SubmitTransfer(ctx, stageIntent(in, "custody_offramp"))
	if err != nil || !settledFact(custody) || strings.TrimSpace(custody.BlockchainTx) == "" {
		result, unknownErr := c.unknown(ctx, record, "custody redemption outcome unknown", errOrMismatch(err))
		return result, record, unknownErr
	}
	record, err = c.advance(ctx, record, StageCustodySubmitted, SagaUpdate{CustodyReference: custody.Reference, BlockchainTx: custody.BlockchainTx, Reason: "custody redemption submitted"})
	if err != nil {
		result, unknownErr := c.unknown(ctx, record, "could not persist custody redemption", err)
		return result, record, unknownErr
	}
	final, err := c.Finality.IsFinal(ctx, custody.BlockchainTx, in.Asset)
	if err != nil || !final {
		result, unknownErr := c.unknown(ctx, record, "custody redemption finality unknown", errOrMismatch(err))
		return result, record, unknownErr
	}
	record, err = c.advance(ctx, record, StageFinalityConfirmed, SagaUpdate{Reason: "custody redemption finality confirmed"})
	if err != nil {
		result, unknownErr := c.unknown(ctx, record, "could not persist redemption finality", err)
		return result, record, unknownErr
	}
	fiat, err := c.Fiat.Payout(ctx, stageIntent(in, "fiat_payout"))
	if err != nil || !settledFact(fiat) {
		result, unknownErr := c.unknown(ctx, record, "fiat payout outcome unknown", errOrMismatch(err))
		return result, record, unknownErr
	}
	record, err = c.advance(ctx, record, StageFiatSubmitted, SagaUpdate{ProviderReference: fiat.Reference, Reason: "fiat payout confirmed"})
	if err != nil {
		result, unknownErr := c.unknown(ctx, record, "could not persist fiat payout", err)
		return result, record, unknownErr
	}
	fiat.BlockchainTx = custody.BlockchainTx
	return fiat, record, nil
}

func (c *Coordinator) handlePreCustodyFailure(ctx context.Context, in Intent, record SettlementRecord, pending LedgerFact, result ProviderResult, label string, cause error) (ProviderResult, SettlementRecord, error) {
	// A provider may explicitly prove that it had no business effect. Only then
	// may the pending ledger transfer be voided. Transport errors and a missing
	// proof of no effect are UNKNOWN, not a compensating retry.
	if cause == nil && result.State == Failed && result.RetryableWithoutEffect {
		if err := c.Ledger.Void(ctx, stageIntent(in, "ledger_void"), pending, label+" had no effect"); err != nil {
			out, unknownErr := c.unknown(ctx, record, "pending ledger void outcome unknown", err)
			return out, record, unknownErr
		}
		out, heldErr := c.hold(ctx, record, label+" did not complete and pending ledger transfer was voided", ErrHeld)
		return out, record, heldErr
	}
	out, unknownErr := c.unknown(ctx, record, label+" outcome unknown", ErrUnknown)
	return out, record, unknownErr
}

func (c *Coordinator) advance(ctx context.Context, record SettlementRecord, stage ExecutionStage, update SagaUpdate) (SettlementRecord, error) {
	return c.Saga.Advance(ctx, record, stage, update)
}

func (c *Coordinator) hold(ctx context.Context, record SettlementRecord, reason string, cause error) (ProviderResult, error) {
	if err := c.Saga.MarkHeld(ctx, record, reason); err != nil {
		return c.unknown(ctx, record, "could not persist settlement hold", err)
	}
	if cause == nil {
		cause = ErrHeld
	}
	return ProviderResult{State: Held, Reason: reason}, cause
}

func (c *Coordinator) unknown(ctx context.Context, record SettlementRecord, reason string, cause error) (ProviderResult, error) {
	if err := c.Saga.MarkUnknown(ctx, record, reason); err != nil {
		return ProviderResult{State: Unknown, Reason: "durable unknown state unavailable"}, fmt.Errorf("%w: %v", ErrUnknown, err)
	}
	if cause == nil {
		cause = ErrUnknown
	}
	return ProviderResult{State: Unknown, Reason: reason}, fmt.Errorf("%w: %v", ErrUnknown, cause)
}

func resultFromRecord(record SettlementRecord) (ProviderResult, error) {
	switch record.Stage {
	case StageSettled:
		return ProviderResult{State: Settled, Reference: record.ProviderReference, BlockchainTx: record.BlockchainTx, Reason: "durable settled result"}, nil
	case StageHeld:
		return ProviderResult{State: Held, Reason: record.FailureClass}, ErrHeld
	case StageUnknown:
		return ProviderResult{State: Unknown, Reason: record.FailureClass}, ErrUnknown
	default:
		return ProviderResult{State: Unknown, Reason: "settlement saga is in progress; retry prohibited"}, ErrUnknown
	}
}

func stageIntent(in Intent, stage string) Intent {
	out := in
	out.IdempotencyKey = in.IdempotencyKey + ":" + stage
	return out
}

func settledFact(result ProviderResult) bool {
	return result.State == Settled && strings.TrimSpace(result.Reference) != ""
}

func errOrMismatch(err error) error {
	if err != nil {
		return err
	}
	return ErrMismatch
}

func boundedReason(reason string) string {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return "unspecified"
	}
	if len(reason) > 160 {
		return reason[:160]
	}
	return reason
}

func ledgerFactID(fact LedgerFact) (uint64, error) {
	id, err := strconv.ParseUint(strings.TrimSpace(fact.TransferID), 10, 64)
	if err != nil || id == 0 {
		return 0, errors.New("ledger fact transfer id must be a positive unsigned integer")
	}
	return id, nil
}

func validateLedgerFact(fact LedgerFact, in Intent, expected State) error {
	if fact.AmountMinor != in.AmountMinor || !strings.EqualFold(fact.Currency, in.Fiat) || !strings.EqualFold(fact.State, string(expected)) {
		return ErrMismatch
	}
	if strings.TrimSpace(fact.TransferID) == "" || strings.TrimSpace(fact.DebitAccount) == "" || strings.TrimSpace(fact.CreditAccount) == "" {
		return ErrMismatch
	}
	return nil
}

func validateIntent(in Intent) error {
	if strings.TrimSpace(in.ID) == "" || strings.TrimSpace(in.IdempotencyKey) == "" || strings.TrimSpace(in.TenantID) == "" || strings.TrimSpace(in.Asset) == "" || strings.TrimSpace(in.Fiat) == "" || in.AmountMinor <= 0 || len(in.Payload) == 0 || (in.Direction != Onramp && in.Direction != Offramp) {
		return ErrInvalidIntent
	}
	if !in.ExpiresAt.IsZero() && time.Now().After(in.ExpiresAt) {
		return fmt.Errorf("%w: expired", ErrInvalidIntent)
	}
	return nil
}
func PayloadDigest(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func Reconcile(ledger LedgerFact, provider ProviderResult, att AttestationFact, expectedDigest string) error {
	if ledger.State != string(Settled) || provider.State != Settled {
		return ErrMismatch
	}
	if strings.TrimSpace(provider.Reference) == "" || strings.TrimSpace(att.ID) == "" || att.Digest != expectedDigest {
		return ErrMismatch
	}
	return nil
}
