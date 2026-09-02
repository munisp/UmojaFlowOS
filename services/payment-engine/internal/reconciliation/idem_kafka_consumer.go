package reconciliation

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/eventing"
	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/ledger"
	"github.com/twmb/franz-go/pkg/kgo"
)

const SettlementReconciledV1 = "umojaflowos.stablecoin.settlement-reconciled.v1"

// SettlementReconciledPayload is the only event shape accepted by this consumer.
// A status that is not explicitly conclusive is mapped to UNKNOWN.
type SettlementReconciledPayload struct {
	TenantID            string `json:"tenant_id"`
	IntentID            string `json:"intent_id"`
	IdempotencyKey      string `json:"idempotency_key"`
	ReleaseSHA          string `json:"release_sha"`
	ReconciliationRunID string `json:"reconciliation_run_id"`
	Status              string `json:"status"`
	ProviderRef         string `json:"provider_ref,omitempty"`
	Asset               string `json:"asset"`
	AmountMinor         uint64 `json:"amount_minor"`
	DebitAccountID      uint64 `json:"debit_account_id"`
	CreditAccountID     uint64 `json:"credit_account_id"`
	ProviderFinal       bool   `json:"provider_final"`
	BusinessEffect      bool   `json:"business_effect"`
	EvidenceSHA256      string `json:"evidence_sha256"`
}

type IntentRecord struct {
	TenantID            string
	IntentID            string
	IdempotencyKey      string
	ReleaseSHA          string
	ReconciliationRunID string
	Status              string
	Asset               string
	AmountMinor         uint64
	DebitAccountID      uint64
	CreditAccountID     uint64
	PayloadSHA256       string
}

// ReconciliationStore is the durable state boundary. Implementations must use
// PostgreSQL row locks/CAS and must enforce tenant context through RLS.
type ReconciliationStore interface {
	ReserveEvent(context.Context, SettlementReconciledPayload, string, time.Time) (bool, error)
	LoadIntent(context.Context, string, string) (IntentRecord, error)
	MarkUnknown(context.Context, SettlementReconciledPayload, string, time.Time) error
	MarkSettled(context.Context, SettlementReconciledPayload, uint64, string, time.Time) error
	MarkEventProcessed(context.Context, string, string, time.Time) error
}

// AuthoritativeLedger is intentionally narrow. The concrete implementation is
// internal/ledger.PostingService, backed by TigerBeetle and its PostgreSQL
// projection sink. Repeated transfer IDs are safe retries at the TB boundary.
type AuthoritativeLedger interface {
	PostConfirmedTransfer(context.Context, ledger.PostingRequest) (ledger.PostedTransferFact, error)
}

type IntentPolicyInput struct {
	TenantID            string `json:"tenant_id"`
	IntentID            string `json:"intent_id"`
	IdempotencyKey      string `json:"idempotency_key"`
	ReleaseSHA          string `json:"release_sha"`
	ReconciliationRunID string `json:"reconciliation_run_id"`
	Asset               string `json:"asset"`
	AmountMinor         uint64 `json:"amount_minor"`
	Direction           string `json:"direction"`
	ProviderFinal       bool   `json:"provider_final"`
	BusinessEffect      bool   `json:"business_effect"`
}

type IntentPolicyDecision struct {
	Allow  bool
	Reason string
}

type IntentPolicy interface {
	Evaluate(context.Context, IntentPolicyInput) (IntentPolicyDecision, error)
}

type AllowAllIntentPolicy struct{}

func (AllowAllIntentPolicy) Evaluate(context.Context, IntentPolicyInput) (IntentPolicyDecision, error) {
	return IntentPolicyDecision{Allow: true, Reason: "explicitly configured development policy"}, nil
}

type Consumer struct {
	Client  *kgo.Client
	Topic   string
	Store   ReconciliationStore
	Ledger  AuthoritativeLedger
	Policy  IntentPolicy
	Now     func() time.Time
	Metrics OPAEvaluationMetrics
}

func (c *Consumer) Consume(ctx context.Context) error {
	if c == nil || c.Client == nil || c.Store == nil || c.Ledger == nil || c.Policy == nil || strings.TrimSpace(c.Topic) == "" {
		return errors.New("Kafka consumer, topic, store, policy, and TigerBeetle ledger are required")
	}
	for {
		fetches := c.Client.PollFetches(ctx)
		if errs := fetches.Errors(); len(errs) > 0 {
			return fmt.Errorf("Kafka fetch failed: %v", errs)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		var records []*kgo.Record
		fetches.EachRecord(func(record *kgo.Record) {
			if record.Topic == c.Topic {
				records = append(records, record)
			}
		})
		for _, record := range records {
			if err := c.HandleRecord(ctx, record); err != nil {
				// Do not commit this record. The process may stop or the broker may
				// redeliver it; the inbox and deterministic TB transfer ID make the
				// retry safe. Poison events remain visible for operational quarantine.
				return err
			}
			if err := c.Client.CommitRecords(ctx, record); err != nil {
				return fmt.Errorf("commit Kafka reconciliation record: %w", err)
			}
		}
	}
}

func (c *Consumer) HandleRecord(ctx context.Context, record *kgo.Record) error {
	if record == nil || len(record.Value) == 0 {
		return errors.New("empty Kafka reconciliation record")
	}
	var envelope eventing.Envelope
	if err := json.Unmarshal(record.Value, &envelope); err != nil {
		return fmt.Errorf("decode event envelope: %w", err)
	}
	if envelope.EventType != SettlementReconciledV1 || envelope.SchemaVersion != "v1" {
		return fmt.Errorf("unsupported settlement event type/version: %s/%s", envelope.EventType, envelope.SchemaVersion)
	}
	if envelope.EventID == "" || envelope.CorrelationID == "" || len(envelope.Payload) == 0 {
		return errors.New("settlement event envelope is incomplete")
	}
	var payload SettlementReconciledPayload
	if err := json.Unmarshal(envelope.Payload, &payload); err != nil {
		return fmt.Errorf("decode settlement reconciliation payload: %w", err)
	}
	if err := validatePayload(payload); err != nil {
		return err
	}
	payloadDigest := sha256.Sum256(envelope.Payload)
	if payload.EvidenceSHA256 != "" && payload.EvidenceSHA256 != hex.EncodeToString(payloadDigest[:]) {
		return errors.New("settlement event evidence SHA-256 mismatch")
	}
	now := time.Now().UTC()
	if c.Now != nil {
		now = c.Now().UTC()
	}
	reserved, err := c.Store.ReserveEvent(ctx, payload, envelope.EventID, now)
	if err != nil {
		return fmt.Errorf("reserve reconciliation event: %w", err)
	}
	if !reserved {
		// Already processed or in-flight. The inbox is the durable idempotency
		// boundary; safe to commit the Kafka record.
		return nil
	}
	intent, err := c.Store.LoadIntent(ctx, payload.TenantID, payload.IdempotencyKey)
	if err != nil {
		return fmt.Errorf("load stablecoin intent: %w", err)
	}
	if intent.IntentID != payload.IntentID || intent.ReleaseSHA != payload.ReleaseSHA || intent.ReconciliationRunID != payload.ReconciliationRunID {
		if markErr := c.Store.MarkUnknown(ctx, payload, "intent binding mismatch", now); markErr != nil {
			return markErr
		}
		return errors.New("settlement event does not match durable intent binding")
	}
	if intent.Status == "SETTLED" || intent.Status == "FAILED" || intent.Status == "HELD" {
		return c.Store.MarkEventProcessed(ctx, envelope.EventID, payload.TenantID, now)
	}
	if !isConclusive(payload) {
		if err := c.Store.MarkUnknown(ctx, payload, "reconciliation result is non-conclusive", now); err != nil {
			return err
		}
		return c.Store.MarkEventProcessed(ctx, envelope.EventID, payload.TenantID, now)
	}
	decision, err := c.evaluateOPAWithRetry(ctx, IntentPolicyInput{
		TenantID: payload.TenantID, IntentID: payload.IntentID, IdempotencyKey: payload.IdempotencyKey,
		ReleaseSHA: payload.ReleaseSHA, ReconciliationRunID: payload.ReconciliationRunID,
		Asset: payload.Asset, AmountMinor: payload.AmountMinor, ProviderFinal: payload.ProviderFinal,
		BusinessEffect: payload.BusinessEffect,
	})

	if err != nil {
		if markErr := c.Store.MarkUnknown(ctx, payload, "OPA policy evaluation unavailable", now); markErr != nil {
			return markErr
		}
		return fmt.Errorf("OPA policy evaluation: %w", err)
	}
	if !decision.Allow {
		if err := c.Store.MarkUnknown(ctx, payload, "OPA denied intent: "+decision.Reason, now); err != nil {
			return err
		}
		return c.Store.MarkEventProcessed(ctx, envelope.EventID, payload.TenantID, now)
	}
	transferID := deterministicTransferID(payload.TenantID, payload.IdempotencyKey)
	if _, err := c.Ledger.PostConfirmedTransfer(ctx, ledger.PostingRequest{
		TransferID: transferID, CorrelationID: payload.IntentID, Currency: payload.Asset,
		Amount: payload.AmountMinor, DebitAccountID: payload.DebitAccountID,
		CreditAccountID: payload.CreditAccountID,
	}); err != nil {
		// The result may be ambiguous. Do not retry another transfer or commit
		// the Kafka offset; record UNKNOWN and let durable reconciliation retry.
		if markErr := c.Store.MarkUnknown(ctx, payload, "TigerBeetle posting was not conclusively acknowledged", now); markErr != nil {
			return markErr
		}
		return fmt.Errorf("TigerBeetle authoritative posting: %w", err)
	}
	if err := c.Store.MarkSettled(ctx, payload, transferID, payload.ProviderRef, now); err != nil {
		// TigerBeetle is confirmed but the database decision is pending. Replay
		// with the same deterministic transfer ID; never create a new transfer.
		return fmt.Errorf("TigerBeetle confirmed but PostgreSQL settlement decision is pending: %w", err)
	}
	return c.Store.MarkEventProcessed(ctx, envelope.EventID, payload.TenantID, now)
}

func validatePayload(p SettlementReconciledPayload) error {
	if p.TenantID == "" || p.IntentID == "" || p.IdempotencyKey == "" || p.ReleaseSHA == "" || p.ReconciliationRunID == "" {
		return errors.New("tenant, intent, idempotency, release SHA, and reconciliation run ID are required")
	}
	if p.AmountMinor == 0 || p.DebitAccountID == 0 || p.CreditAccountID == 0 || p.DebitAccountID == p.CreditAccountID {
		return errors.New("positive amount and distinct ledger accounts are required")
	}
	if !p.ProviderFinal || !p.BusinessEffect {
		return nil
	}
	return nil
}

func isConclusive(p SettlementReconciledPayload) bool {
	return p.ProviderFinal && p.BusinessEffect && (strings.EqualFold(p.Status, "SETTLED") || strings.EqualFold(p.Status, "CONFIRMED"))
}

func deterministicTransferID(tenantID, idempotencyKey string) uint64 {
	digest := sha256.Sum256([]byte(tenantID + "\x00" + idempotencyKey))
	var id uint64
	for _, b := range digest[:8] {
		id = (id << 8) | uint64(b)
	}
	if id == 0 {
		return 1
	}
	return id
}

// PostgresReconciliationStore is a concrete implementation for the migration
// 0058 tables. Every method binds tenant context before touching RLS tables.
type PostgresReconciliationStore struct{ DB *sql.DB }

func (s *PostgresReconciliationStore) tx(ctx context.Context, tenantID string) (*sql.Tx, error) {
	if s == nil || s.DB == nil || strings.TrimSpace(tenantID) == "" {
		return nil, errors.New("PostgreSQL store and tenant are required")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback()
		return nil, err
	}
	return tx, nil
}

func (s *PostgresReconciliationStore) ReserveEvent(ctx context.Context, p SettlementReconciledPayload, eventID string, now time.Time) (bool, error) {
	tx, err := s.tx(ctx, p.TenantID)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO stablecoin_event_inbox (tenant_id,event_id,event_type,correlation_id,payload_sha256,reconciliation_run_id,received_at) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,event_id) DO NOTHING`, p.TenantID, eventID, SettlementReconciledV1, p.IntentID, p.EvidenceSHA256, p.ReconciliationRunID, now)
	if err != nil {
		return false, err
	}
	var inserted bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM stablecoin_event_inbox WHERE tenant_id=$1 AND event_id=$2 AND processed_at IS NULL)`, p.TenantID, eventID).Scan(&inserted); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return inserted, nil
}

func (s *PostgresReconciliationStore) LoadIntent(ctx context.Context, tenantID, key string) (IntentRecord, error) {
	tx, err := s.tx(ctx, tenantID)
	if err != nil {
		return IntentRecord{}, err
	}
	defer tx.Rollback()
	var out IntentRecord
	err = tx.QueryRowContext(ctx, `SELECT tenant_id,id::text,idempotency_key,release_sha,reconciliation_run_id,status,asset,amount_minor,debit_account_id,credit_account_id,payload_sha256 FROM stablecoin_intent WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`, tenantID, key).Scan(&out.TenantID, &out.IntentID, &out.IdempotencyKey, &out.ReleaseSHA, &out.ReconciliationRunID, &out.Status, &out.Asset, &out.AmountMinor, &out.DebitAccountID, &out.CreditAccountID, &out.PayloadSHA256)
	if err != nil {
		return IntentRecord{}, err
	}
	if err := tx.Commit(); err != nil {
		return IntentRecord{}, err
	}
	return out, nil
}

func (s *PostgresReconciliationStore) MarkUnknown(ctx context.Context, p SettlementReconciledPayload, reason string, now time.Time) error {
	return s.updateIntent(ctx, p, "UNKNOWN", 0, p.ProviderRef, reason, now)
}
func (s *PostgresReconciliationStore) MarkSettled(ctx context.Context, p SettlementReconciledPayload, transferID uint64, providerRef string, now time.Time) error {
	return s.updateIntent(ctx, p, "SETTLED", transferID, providerRef, "confirmed reconciliation event", now)
}
func (s *PostgresReconciliationStore) updateIntent(ctx context.Context, p SettlementReconciledPayload, status string, transferID uint64, providerRef, reason string, now time.Time) error {
	tx, err := s.tx(ctx, p.TenantID)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `UPDATE stablecoin_intent SET status=$1,provider_ref=NULLIF($2,''),tigerbeetle_transfer_id=NULLIF($3,0),updated_at=$4,terminal_at=CASE WHEN $1 IN ('SETTLED','FAILED','HELD') THEN $4 ELSE terminal_at END WHERE tenant_id=$5 AND idempotency_key=$6 AND release_sha=$7 AND reconciliation_run_id=$8`, status, providerRef, transferID, now, p.TenantID, p.IdempotencyKey, p.ReleaseSHA, p.ReconciliationRunID)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO stablecoin_terminal_decision (tenant_id,intent_id,idempotency_key,decision,tigerbeetle_transfer_id,provider_ref,reconciliation_run_id,evidence_sha256,decided_at) SELECT tenant_id,id,idempotency_key,$1,NULLIF($2,0),NULLIF($3,''),reconciliation_run_id,$4,$5 FROM stablecoin_intent WHERE tenant_id=$6 AND idempotency_key=$7 AND $1 IN ('SETTLED','FAILED','HELD') ON CONFLICT DO NOTHING`, status, transferID, providerRef, p.EvidenceSHA256, now, p.TenantID, p.IdempotencyKey)
	if err != nil {
		return err
	}
	_ = reason // reason is retained by the surrounding audit/event layer.
	return tx.Commit()
}
func (s *PostgresReconciliationStore) MarkEventProcessed(ctx context.Context, eventID, tenantID string, now time.Time) error {
	tx, err := s.tx(ctx, tenantID)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE stablecoin_event_inbox SET processed_at=$1 WHERE tenant_id=$2 AND event_id=$3 AND processed_at IS NULL`, now, tenantID, eventID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return errors.New("event was not reserved or was already processed")
	}
	return tx.Commit()
}
