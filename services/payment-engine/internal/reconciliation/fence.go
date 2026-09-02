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

type SettlementFence struct {
	mu       sync.RWMutex
	fenced   bool
	version  uint64
	reason   string
	audit    FenceAudit
	verifier ed25519.PublicKey
	seen     map[string]time.Time
}

func NewSettlementFence(verifier ed25519.PublicKey, audit FenceAudit) (*SettlementFence, error) {
	if len(verifier) != ed25519.PublicKeySize {
		return nil, errors.New("Ed25519 fence verifier key is required")
	}
	return &SettlementFence{fenced: true, audit: audit, verifier: verifier, seen: map[string]time.Time{}}, nil
}
func (f *SettlementFence) IsFenced() bool { f.mu.RLock(); defer f.mu.RUnlock(); return f.fenced }
func (f *SettlementFence) Reason() string { f.mu.RLock(); defer f.mu.RUnlock(); return f.reason }
func (f *SettlementFence) Check() error {
	if f == nil {
		return errors.New("settlement fence is unavailable")
	}
	if f.IsFenced() {
		return fmt.Errorf("settlement fenced: %s", f.Reason())
	}
	return nil
}
func canonicalFencePayload(c FenceCommand) ([]byte, error) { c.Signature = ""; return json.Marshal(c) }
func (f *SettlementFence) Apply(c FenceCommand, now time.Time) error {
	if f == nil {
		return errors.New("settlement fence is unavailable")
	}
	if c.CommandID == "" || c.Reason == "" || c.Environment == "" || c.Nonce == "" || c.Signer == "" {
		return errors.New("fence command identity, reason, environment, nonce, and signer are required")
	}
	if c.Action != FenceActionFence && c.Action != FenceActionOpen {
		return errors.New("unsupported fence action")
	}
	if now.Before(c.IssuedAt) || !now.Before(c.ExpiresAt) {
		return errors.New("fence command is outside its validity window")
	}
	if len(c.SourceAlerts) == 0 {
		return errors.New("source alerts are required")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.seen[c.CommandID]; ok {
		return nil
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
	if f.audit != nil {
		if err := f.audit.RecordFenceCommand(c, auditHash); err != nil {
			return fmt.Errorf("fence audit failed: %w", err)
		}
	}
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

func (g GuardedLedger) PostConfirmedTransfer(ctx context.Context, req ledger.PostingRequest) (ledger.PostedTransferFact, error) {
	if g.Fence == nil || g.Inner == nil {
		return ledger.PostedTransferFact{}, errors.New("guarded ledger dependencies are required")
	}
	if err := g.Fence.Check(); err != nil {
		return ledger.PostedTransferFact{}, err
	}
	return g.Inner.PostConfirmedTransfer(ctx, req)
}

type FenceHTTPHandler struct {
	Fence *SettlementFence
	Now   func() time.Time
}

func (h FenceHTTPHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != "POST" {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()
	limited := io.LimitReader(r.Body, 1<<20)
	var c FenceCommand
	if err := json.NewDecoder(limited).Decode(&c); err != nil {
		http.Error(w, "invalid JSON", 400)
		return
	}
	now := time.Now().UTC()
	if h.Now != nil {
		now = h.Now().UTC()
	}
	if err := h.Fence.Apply(c, now); err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"accepted": true, "command_id": c.CommandID, "fenced": h.Fence.IsFenced()})
}
