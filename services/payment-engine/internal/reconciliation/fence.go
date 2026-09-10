package reconciliation

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/ledger"
)

type FenceAction string

const (
	FenceActionOpen  FenceAction = "OPEN"
	FenceActionFence FenceAction = "FENCE"
)

type FenceCommand struct {
	CommandID    string      `json:"command_id"`
	Action       FenceAction `json:"action"`
	Reason       string      `json:"reason"`
	Environment  string      `json:"environment"`
	SourceAlerts []string    `json:"source_alerts"`
	IssuedAt     time.Time   `json:"issued_at"`
	ExpiresAt    time.Time   `json:"expires_at"`
	Nonce        string      `json:"nonce"`
	Signer       string      `json:"signer"`
	Signature    string      `json:"signature"`
}

type FenceAudit interface {
	RecordFenceCommand(FenceCommand, string) error
}

type FenceState struct {
	Environment string
	Fenced      bool
	Version     uint64
	Reason      string
	CommandID   string
}

type DurableFenceStore interface {
	LoadState(context.Context, string) (FenceState, error)
}

type DurableAdmissionStore interface {
	AcquireAdmission(context.Context, string) (ledger.AdmissionToken, error)
}

type FenceStateCommandStore interface {
	FenceAudit
	DurableFenceStore
	RecordFenceCommandContext(context.Context, FenceCommand, string) error
}

type SettlementFence struct {
	mu          sync.RWMutex
	fenced      bool
	version     uint64
	reason      string
	environment string
	audit       FenceAudit
	durable     DurableFenceStore
	verifier    ed25519.PublicKey
	seen        map[string]time.Time
}

func NewSettlementFence(verifier ed25519.PublicKey, audit FenceAudit) (*SettlementFence, error) {
	if len(verifier) != ed25519.PublicKeySize {
		return nil, errors.New("Ed25519 fence verifier key is required")
	}
	return &SettlementFence{
		fenced:   true,
		reason:   "startup fail-closed fence",
		audit:    audit,
		verifier: verifier,
		seen:     map[string]time.Time{},
	}, nil
}

func NewDurableSettlementFence(verifier ed25519.PublicKey, environment string, store FenceStateCommandStore) (*SettlementFence, error) {
	if store == nil {
		return nil, errors.New("durable fence store is required")
	}
	if environment == "" {
		return nil, errors.New("fence environment is required")
	}
	fence, err := NewSettlementFence(verifier, store)
	if err != nil {
		return nil, err
	}
	fence.environment = environment
	fence.durable = store
	return fence, nil
}

func (f *SettlementFence) IsFenced() bool {
	if f == nil {
		return true
	}
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.fenced
}

func (f *SettlementFence) Reason() string {
	if f == nil {
		return "settlement fence is unavailable"
	}
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.reason
}

func (f *SettlementFence) setLocalState(state FenceState) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fenced = state.Fenced
	f.version = state.Version
	f.reason = state.Reason
}

func (f *SettlementFence) Check() error {
	return f.CheckContext(context.Background())
}

// CheckContext refreshes the durable state on every authoritative ledger
// attempt. A missing row or any store error is fenced, never opened.
func (f *SettlementFence) CheckContext(ctx context.Context) error {
	if f == nil {
		return errors.New("settlement fence is unavailable")
	}
	if f.durable != nil {
		state, err := f.durable.LoadState(ctx, f.environment)
		if err != nil {
			f.setLocalState(FenceState{Fenced: true, Reason: "durable fence state unavailable"})
			return fmt.Errorf("settlement fence state unavailable: %w", err)
		}
		f.setLocalState(state)
		if state.Fenced {
			return fmt.Errorf("settlement fenced: %s", state.Reason)
		}
		return nil
	}
	if f.IsFenced() {
		return fmt.Errorf("settlement fenced: %s", f.Reason())
	}
	return nil
}

func canonicalFencePayload(c FenceCommand) ([]byte, error) {
	c.Signature = ""
	return json.Marshal(c)
}

func (f *SettlementFence) Apply(c FenceCommand, now time.Time) error {
	return f.ApplyContext(context.Background(), c, now)
}

func (f *SettlementFence) ApplyContext(ctx context.Context, c FenceCommand, now time.Time) error {
	if f == nil {
		return errors.New("settlement fence is unavailable")
	}
	if c.CommandID == "" || c.Reason == "" || c.Environment == "" || c.Nonce == "" || c.Signer == "" {
		return errors.New("fence command identity, reason, environment, nonce, and signer are required")
	}
	if c.Action != FenceActionFence && c.Action != FenceActionOpen {
		return errors.New("unsupported fence action")
	}
	if f.environment != "" && c.Environment != f.environment {
		return errors.New("fence command environment does not match payment-engine environment")
	}
	if !now.Before(c.ExpiresAt) || now.Before(c.IssuedAt) {
		return errors.New("fence command is outside its validity window")
	}
	if c.ExpiresAt.Sub(c.IssuedAt) > 15*time.Minute {
		return errors.New("fence command validity window exceeds 15 minutes")
	}
	if len(c.SourceAlerts) == 0 {
		return errors.New("source alerts are required")
	}

	payload, err := canonicalFencePayload(c)
	if err != nil {
		return err
	}
	sig, err := base64.StdEncoding.DecodeString(c.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize || !ed25519.Verify(f.verifier, payload, sig) {
		return errors.New("invalid fence command signature")
	}

	digest := sha256.Sum256(payload)
	auditHash := hex.EncodeToString(digest[:])
	f.mu.RLock()
	_, locallySeen := f.seen[c.CommandID]
	f.mu.RUnlock()
	if locallySeen {
		return nil
	}
	if contextStore, ok := f.audit.(FenceStateCommandStore); ok {
		if err := contextStore.RecordFenceCommandContext(ctx, c, auditHash); err != nil {
			return fmt.Errorf("durable fence command failed: %w", err)
		}
	} else if f.audit != nil {
		if err := f.audit.RecordFenceCommand(c, auditHash); err != nil {
			return fmt.Errorf("fence audit failed: %w", err)
		}
	}

	f.mu.Lock()
	if _, ok := f.seen[c.CommandID]; ok {
		f.mu.Unlock()
		return nil
	}
	defer f.mu.Unlock()
	f.fenced = c.Action == FenceActionFence
	f.reason = c.Reason
	f.version++
	f.seen[c.CommandID] = c.ExpiresAt
	return nil
}

type GuardedLedger struct {
	Fence *SettlementFence
	Inner AuthoritativeLedger
}

type pendingPostingLedger interface {
	PostPendingTransfer(context.Context, ledger.PostingRequest) (ledger.PostedTransferFact, error)
	CommitPendingTransfer(context.Context, ledger.PostingRequest) (ledger.PostedTransferFact, error)
	VoidPendingTransfer(context.Context, ledger.PostingRequest) (ledger.PostedTransferFact, error)
}

type pendingPostingLedgerWithAdmission interface {
	PostPendingTransferWithAdmission(context.Context, ledger.PostingRequest, ledger.AdmissionToken) (ledger.PostedTransferFact, error)
	CommitPendingTransferWithAdmission(context.Context, ledger.PostingRequest, ledger.AdmissionToken) (ledger.PostedTransferFact, error)
	VoidPendingTransferWithAdmission(context.Context, ledger.PostingRequest, ledger.AdmissionToken) (ledger.PostedTransferFact, error)
}

func (g GuardedLedger) PostConfirmedTransfer(ctx context.Context, req ledger.PostingRequest) (ledger.PostedTransferFact, error) {
	if g.Fence == nil || g.Inner == nil {
		return ledger.PostedTransferFact{}, errors.New("guarded ledger dependencies are required")
	}
	if g.Fence.durable != nil {
		if admissionStore, ok := g.Fence.durable.(DurableAdmissionStore); ok {
			token, err := admissionStore.AcquireAdmission(ctx, g.Fence.environment)
			if err != nil {
				g.Fence.setLocalState(FenceState{Fenced: true, Reason: "durable admission unavailable"})
				return ledger.PostedTransferFact{}, fmt.Errorf("settlement admission unavailable: %w", err)
			}
			if aware, ok := g.Inner.(interface {
				PostConfirmedTransferWithAdmission(context.Context, ledger.PostingRequest, ledger.AdmissionToken) (ledger.PostedTransferFact, error)
			}); ok {
				fact, postErr := aware.PostConfirmedTransferWithAdmission(ctx, req, token)
				releaseErr := token.Release()
				if postErr != nil {
					return fact, postErr
				}
				if releaseErr != nil {
					return fact, fmt.Errorf("release settlement admission: %w", releaseErr)
				}
				return fact, nil
			}
			defer token.Release()
		}
	}
	if err := g.Fence.CheckContext(ctx); err != nil {
		return ledger.PostedTransferFact{}, err
	}
	return g.Inner.PostConfirmedTransfer(ctx, req)
}

func (g GuardedLedger) PostPendingTransfer(ctx context.Context, req ledger.PostingRequest) (ledger.PostedTransferFact, error) {
	return g.postPendingOperation(ctx, req, "prepare")
}

func (g GuardedLedger) CommitPendingTransfer(ctx context.Context, req ledger.PostingRequest) (ledger.PostedTransferFact, error) {
	return g.postPendingOperation(ctx, req, "commit")
}

func (g GuardedLedger) VoidPendingTransfer(ctx context.Context, req ledger.PostingRequest) (ledger.PostedTransferFact, error) {
	return g.postPendingOperation(ctx, req, "void")
}

func (g GuardedLedger) postPendingOperation(ctx context.Context, req ledger.PostingRequest, operation string) (ledger.PostedTransferFact, error) {
	if g.Fence == nil || g.Inner == nil {
		return ledger.PostedTransferFact{}, errors.New("guarded ledger dependencies are required")
	}
	inner, ok := g.Inner.(pendingPostingLedger)
	if !ok {
		return ledger.PostedTransferFact{}, errors.New("ledger does not support pending settlement operations")
	}
	invoke := func(token *ledger.AdmissionToken) (ledger.PostedTransferFact, error) {
		if token != nil {
			if aware, ok := g.Inner.(pendingPostingLedgerWithAdmission); ok {
				switch operation {
				case "prepare":
					return aware.PostPendingTransferWithAdmission(ctx, req, *token)
				case "commit":
					return aware.CommitPendingTransferWithAdmission(ctx, req, *token)
				case "void":
					return aware.VoidPendingTransferWithAdmission(ctx, req, *token)
				}
			}
		}
		switch operation {
		case "prepare":
			return inner.PostPendingTransfer(ctx, req)
		case "commit":
			return inner.CommitPendingTransfer(ctx, req)
		case "void":
			return inner.VoidPendingTransfer(ctx, req)
		default:
			return ledger.PostedTransferFact{}, errors.New("unsupported guarded pending operation")
		}
	}
	if g.Fence.durable != nil {
		admissionStore, ok := g.Fence.durable.(DurableAdmissionStore)
		if !ok {
			g.Fence.setLocalState(FenceState{Fenced: true, Reason: "durable admission store unavailable"})
			return ledger.PostedTransferFact{}, errors.New("durable settlement admission is required")
		}
		token, err := admissionStore.AcquireAdmission(ctx, g.Fence.environment)
		if err != nil {
			g.Fence.setLocalState(FenceState{Fenced: true, Reason: "durable admission unavailable"})
			return ledger.PostedTransferFact{}, fmt.Errorf("settlement admission unavailable: %w", err)
		}
		fact, invokeErr := invoke(&token)
		releaseErr := token.Release()
		if invokeErr != nil {
			return fact, invokeErr
		}
		if releaseErr != nil {
			return fact, fmt.Errorf("release settlement admission: %w", releaseErr)
		}
		return fact, nil
	}
	if err := g.Fence.CheckContext(ctx); err != nil {
		return ledger.PostedTransferFact{}, err
	}
	return invoke(nil)
}

type FenceHTTPHandler struct {
	Fence *SettlementFence
	Now   func() time.Time
}

func (h FenceHTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if h.Fence == nil {
		http.Error(w, "settlement fence unavailable", http.StatusServiceUnavailable)
		return
	}
	defer r.Body.Close()
	limited := io.LimitReader(r.Body, 1<<20)
	var c FenceCommand
	if err := json.NewDecoder(limited).Decode(&c); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}
	now := time.Now().UTC()
	if h.Now != nil {
		now = h.Now().UTC()
	}
	if err := h.Fence.ApplyContext(r.Context(), c, now); err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"accepted":   true,
		"command_id": c.CommandID,
		"fenced":     h.Fence.IsFenced(),
	})
}
