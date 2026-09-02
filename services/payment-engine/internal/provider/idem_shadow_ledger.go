package provider

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/multirail"
)

// IdemShadowClient is an adapter boundary for Idem or an Idem-inspired
// internal shadow ledger. It must never be used as settlement authority.
type IdemShadowClient interface {
	PostTransaction(context.Context, IdemTransactionRequest) (IdemTransactionResponse, error)
	ReconcileBatch(context.Context, IdemBatchRequest) (IdemBatchResponse, error)
}

type IdemTransactionRequest struct {
	IdempotencyKey string            `json:"idempotency_key"`
	TenantID       string            `json:"tenant_id"`
	ReleaseSHA     string            `json:"release_sha"`
	RunID          string            `json:"reconciliation_run_id"`
	Lines          []IdemJournalLine `json:"lines"`
	Metadata       map[string]string `json:"metadata,omitempty"`
}

type IdemJournalLine struct {
	AccountID   string `json:"account_id"`
	EntryType   string `json:"entry_type"`
	Asset       string `json:"asset"`
	AmountMinor int64  `json:"amount_minor"`
	Chain       string `json:"chain,omitempty"`
	TxHash      string `json:"tx_hash,omitempty"`
}

type IdemTransactionResponse struct {
	TransactionID string `json:"transaction_id"`
	Status        string `json:"status"`
	Idempotent    bool   `json:"idempotent"`
}

type IdemBatchRequest struct {
	RunID          string   `json:"reconciliation_run_id"`
	TransactionIDs []string `json:"transaction_ids"`
}

type IdemBatchItem struct {
	TransactionID string `json:"transaction_id"`
	Status        string `json:"status"`
	ProviderRef   string `json:"provider_ref,omitempty"`
	Reason        string `json:"reason,omitempty"`
}

type IdemBatchResponse struct {
	BatchID string          `json:"batch_id"`
	Status  string          `json:"status"` // COMPLETE, PARTIAL, FAILED
	Items   []IdemBatchItem `json:"items"`
	RunID   string          `json:"reconciliation_run_id"`
}

type ShadowLedger struct {
	client IdemShadowClient
}

func NewShadowLedger(client IdemShadowClient) (*ShadowLedger, error) {
	if client == nil {
		return nil, errors.New("idem shadow client is required")
	}
	return &ShadowLedger{client: client}, nil
}

// ProjectAfterTigerBeetleCommit writes a non-authoritative projection. The
// caller must already have committed the authoritative TigerBeetle posting.
// A shadow failure is returned to the queue layer for durable retry; it never
// causes a second TigerBeetle posting.
func (s *ShadowLedger) ProjectAfterTigerBeetleCommit(ctx context.Context, tenantID, releaseSHA, runID string, in multirail.Intent, debitAccount, creditAccount string) error {
	if s == nil || s.client == nil {
		return errors.New("idem shadow ledger is not configured")
	}
	if strings.TrimSpace(tenantID) == "" || strings.TrimSpace(releaseSHA) == "" || strings.TrimSpace(runID) == "" {
		return errors.New("tenant, release SHA, and reconciliation run ID are required")
	}
	if strings.TrimSpace(in.IdempotencyKey) == "" || in.AmountMinor <= 0 {
		return errors.New("intent idempotency key and positive amount are required")
	}
	digest := sha256.Sum256(in.Payload)
	request := IdemTransactionRequest{
		IdempotencyKey: in.IdempotencyKey,
		TenantID:       tenantID,
		ReleaseSHA:     releaseSHA,
		RunID:          runID,
		Lines: []IdemJournalLine{
			{AccountID: debitAccount, EntryType: "DEBIT", Asset: in.Asset, AmountMinor: in.AmountMinor},
			{AccountID: creditAccount, EntryType: "CREDIT", Asset: in.Asset, AmountMinor: in.AmountMinor},
		},
		Metadata: map[string]string{
			"payload_sha256": hex.EncodeToString(digest[:]),
			"intent_id":      in.ID,
			"fiat":           in.Fiat,
		},
	}
	out, err := s.client.PostTransaction(ctx, request)
	if err != nil {
		return fmt.Errorf("idem shadow projection failed: %w", err)
	}
	if strings.TrimSpace(out.TransactionID) == "" {
		return errors.New("idem shadow response missing transaction ID")
	}
	switch strings.ToUpper(out.Status) {
	case "POSTED", "SETTLED", "ACCEPTED":
		return nil
	default:
		return fmt.Errorf("idem shadow projection not accepted: %s", out.Status)
	}
}

// FailClosedBatchReconciler converts Idem's independently processed batch
// response into durable UmojaFlowOS decisions. A PARTIAL aggregate result is
// never treated as a successful batch. Items without a conclusive, exact
// response become UNKNOWN and cannot authorize a secondary submission.
type FailClosedBatchReconciler struct {
	Client IdemShadowClient
	Store  multirail.UnknownStateStore
	Now    func() time.Time
}

func (r FailClosedBatchReconciler) ReconcileBatch(ctx context.Context, runID string, states []multirail.UnknownState) ([]multirail.ReconciliationResult, error) {
	if r.Client == nil || r.Store == nil || strings.TrimSpace(runID) == "" || len(states) == 0 {
		return nil, errors.New("client, store, run ID, and states are required")
	}
	ids := make([]string, 0, len(states))
	byID := make(map[string]multirail.UnknownState, len(states))
	for _, state := range states {
		if state.Intent.ID == "" || state.Intent.IdempotencyKey == "" {
			return nil, errors.New("unknown state intent ID and idempotency key are required")
		}
		ids = append(ids, state.Intent.ID)
		byID[state.Intent.ID] = state
	}
	response, err := r.Client.ReconcileBatch(ctx, IdemBatchRequest{RunID: runID, TransactionIDs: ids})
	now := time.Now().UTC()
	if r.Now != nil {
		now = r.Now().UTC()
	}
	if err != nil {
		unknownResults, recordErr := r.recordAllUnknown(ctx, states, now, "Idem batch request failed; outcome is unknown")
		if recordErr != nil {
			return unknownResults, fmt.Errorf("record UNKNOWN decisions after Idem batch failure: %w", recordErr)
		}
		return unknownResults, fmt.Errorf("idem batch reconciliation failed: %w", err)
	}
	if response.RunID != runID {
		unknownResults, recordErr := r.recordAllUnknown(ctx, states, now, "Idem response reconciliation run ID mismatch")
		if recordErr != nil {
			return unknownResults, fmt.Errorf("record UNKNOWN decisions after run-ID mismatch: %w", recordErr)
		}
		return unknownResults, errors.New("idem reconciliation run ID mismatch")
	}

	items := make(map[string]IdemBatchItem, len(response.Items))
	for _, item := range response.Items {
		if _, exists := byID[item.TransactionID]; exists {
			items[item.TransactionID] = item
		}
	}
	results := make([]multirail.ReconciliationResult, 0, len(states))
	partial := strings.EqualFold(response.Status, "PARTIAL")
	for _, state := range states {
		item, found := items[state.Intent.ID]
		decision := multirail.DecisionAwaitingEvidence
		status := multirail.Unknown
		reason := "Idem batch item missing or aggregate response is not complete"
		providerRef := state.ProviderRef
		if found && strings.TrimSpace(item.ProviderRef) != "" {
			providerRef = item.ProviderRef
		}
		if found && !partial {
			switch strings.ToUpper(item.Status) {
			case "SETTLED", "POSTED", "ACCEPTED":
				decision = multirail.DecisionProviderAccepted
				status = multirail.Settled
				reason = "Idem independently reported a conclusive shadow-ledger state; settlement authority remains false"
			case "UNMATCHED", "NOT_FOUND", "FAILED_NO_EFFECT":
				decision = multirail.DecisionConfirmedNonSubmission
				status = multirail.Failed
				reason = "Idem explicitly confirmed no matching shadow-ledger effect; secondary execution remains a separate authorization"
			default:
				reason = "Idem item status is not conclusive"
			}
		} else if partial {
			reason = "Idem returned partial batch success; unresolved item is mapped to UNKNOWN"
		}
		result := multirail.ReconciliationResult{
			IntentID: state.Intent.ID, IdempotencyKey: state.Intent.IdempotencyKey,
			PrimaryRail: state.PrimaryRail, ProviderRef: providerRef,
			Decision: decision, ObservedStatus: status, SettlementAllowed: false,
			Attempt: state.Attempts, DecidedAt: now, Reason: reason,
			EvidenceDigest: shadowEvidenceDigest(state, runID, decision, status, reason), LeaseToken: state.LeaseToken,
		}
		if err := r.Store.RecordDecision(ctx, result); err != nil {
			return results, fmt.Errorf("record Idem reconciliation decision for %s: %w", state.Intent.ID, err)
		}
		results = append(results, result)
	}
	if partial {
		return results, errors.New("idem batch was partial; unresolved outcomes remain UNKNOWN")
	}
	return results, nil
}

func (r FailClosedBatchReconciler) recordAllUnknown(ctx context.Context, states []multirail.UnknownState, now time.Time, reason string) ([]multirail.ReconciliationResult, error) {
	results := make([]multirail.ReconciliationResult, 0, len(states))
	for _, state := range states {
		result := multirail.ReconciliationResult{
			IntentID: state.Intent.ID, IdempotencyKey: state.Intent.IdempotencyKey,
			PrimaryRail: state.PrimaryRail, ProviderRef: state.ProviderRef,
			Decision: multirail.DecisionAwaitingEvidence, ObservedStatus: multirail.Unknown,
			SettlementAllowed: false, Attempt: state.Attempts, DecidedAt: now,
			Reason: reason, EvidenceDigest: shadowEvidenceDigest(state, "", multirail.DecisionAwaitingEvidence, multirail.Unknown, reason), LeaseToken: state.LeaseToken,
		}
		if err := r.Store.RecordDecision(ctx, result); err != nil {
			return results, err
		}
		results = append(results, result)
	}
	return results, nil
}

func shadowEvidenceDigest(state multirail.UnknownState, runID string, decision multirail.ReconciliationDecision, status multirail.Status, reason string) string {
	body, _ := json.Marshal(struct {
		ID, Key, RunID, Reason string
		Decision               multirail.ReconciliationDecision
		Status                 multirail.Status
	}{state.Intent.ID, state.Intent.IdempotencyKey, runID, reason, decision, status})
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}

// HTTPIdemClient is an S3/provider-neutral HTTP implementation. Authentication
// and TLS are injected by the caller; this type does not hold private keys.
type HTTPIdemClient struct {
	BaseURL, Token string
	Client         *http.Client
}

func (c HTTPIdemClient) doJSON(ctx context.Context, method, path string, request, response any) error {
	body, err := json.Marshal(request)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.BaseURL, "/")+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if transaction, ok := request.(IdemTransactionRequest); ok && transaction.IdempotencyKey != "" {
		req.Header.Set("Idempotency-Key", transaction.IdempotencyKey)
	}
	client := c.Client
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		return fmt.Errorf("Idem HTTP %s: %s", resp.Status, strings.TrimSpace(string(data)))
	}
	if response == nil {
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(response)
}

func (c HTTPIdemClient) PostTransaction(ctx context.Context, request IdemTransactionRequest) (IdemTransactionResponse, error) {
	var out IdemTransactionResponse
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/transactions", request, &out)
	return out, err
}
func (c HTTPIdemClient) ReconcileBatch(ctx context.Context, request IdemBatchRequest) (IdemBatchResponse, error) {
	var out IdemBatchResponse
	err := c.doJSON(ctx, http.MethodPost, "/api/v1/reconciliation/batch", request, &out)
	return out, err
}
