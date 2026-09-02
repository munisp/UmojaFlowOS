package settlement

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
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
	ErrMismatch      = errors.New("cross-system settlement facts mismatch")
)

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
type Ledger interface {
	Post(context.Context, Intent) (LedgerFact, error)
	Query(context.Context, Intent) (LedgerFact, error)
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
}

func (c *Coordinator) Execute(ctx context.Context, in Intent) (ProviderResult, error) {
	if err := validateIntent(in); err != nil {
		return ProviderResult{}, err
	}
	if c.Screening == nil || c.Ledger == nil || c.Attestor == nil {
		return ProviderResult{}, errors.New("screening, ledger, and attestor are required")
	}
	screen, err := c.Screening.Screen(ctx, in)
	if err != nil {
		return ProviderResult{State: Held, Reason: "screening unavailable"}, err
	}
	if screen.Decision != "clear" {
		return ProviderResult{State: Held, Reason: screen.Reason, Reference: screen.CaseID}, errors.New("settlement held by compliance screening")
	}
	fact, err := c.Ledger.Post(ctx, in)
	if err != nil {
		return ProviderResult{State: Unknown, Reason: "ledger outcome unknown"}, ErrUnknown
	}
	if fact.AmountMinor != in.AmountMinor || strings.ToUpper(fact.Currency) != strings.ToUpper(in.Fiat) {
		return ProviderResult{State: Held, Reason: "ledger fact mismatch"}, ErrMismatch
	}
	digest := PayloadDigest(in.Payload)
	att, err := c.Attestor.Attest(ctx, in, digest)
	if err != nil {
		return ProviderResult{State: Held, Reason: "attestation unavailable"}, err
	}
	if att.Digest != digest || att.EvidenceID == "" {
		return ProviderResult{State: Held, Reason: "attestation binding mismatch"}, ErrMismatch
	}
	ok, err := c.Attestor.Verify(ctx, att)
	if err != nil || !ok {
		return ProviderResult{State: Held, Reason: "attestation verification failed"}, ErrMismatch
	}
	return ProviderResult{State: Settled, Reference: att.ID, Reason: "ledger fact and consortium attestation verified"}, nil
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
