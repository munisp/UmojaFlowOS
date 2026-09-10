package settlement

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
)

// ExecutionStage is a monotonic, persisted settlement-saga state. A state
// becomes terminal only through Settled, Held, or Unknown. Unknown is never
// automatically retried: it requires independent reconciliation.
type ExecutionStage string

const (
	StageReceived            ExecutionStage = "received"
	StageScreened            ExecutionStage = "screened"
	StageRouted              ExecutionStage = "routed"
	StageLiquidityReserved   ExecutionStage = "liquidity_reserved"
	StageLedgerPrepared      ExecutionStage = "ledger_prepared"
	StageFiatSubmitted       ExecutionStage = "fiat_submitted"
	StageCustodySubmitted    ExecutionStage = "custody_submitted"
	StageFinalityConfirmed   ExecutionStage = "finality_confirmed"
	StageLedgerCommitted     ExecutionStage = "ledger_committed"
	StageAttestationVerified ExecutionStage = "attestation_verified"
	StageSettled             ExecutionStage = "settled"
	StageHeld                ExecutionStage = "held"
	StageUnknown             ExecutionStage = "unknown"
)

var (
	ErrSagaConflict        = errors.New("settlement saga transition conflict")
	ErrSagaPayloadChanged  = errors.New("idempotency key is already bound to a different payload")
	ErrSagaTerminal        = errors.New("settlement saga is already terminal")
	ErrInboxPayloadChanged = errors.New("inbox message id is already bound to a different payload")
)

// SettlementRecord is the tenant-owned durable state required to determine
// whether a commercial effect has occurred. IDs and references are immutable
// once recorded by a stage transition.
type SettlementRecord struct {
	TenantID            string
	SagaID              string
	IntentID            string
	IdempotencyKey      string
	PayloadSHA256       string
	Direction           Direction
	Asset               string
	Fiat                string
	AmountMinor         int64
	Destination         string
	Stage               ExecutionStage
	RouteID             string
	ProviderReference   string
	CustodyReference    string
	BlockchainTx        string
	LedgerPendingID     uint64
	LedgerTransferID    uint64
	AttestationID       string
	FailureClass        string
	ReconciliationRunID string
	Version             int64
	CreatedAt           time.Time
	UpdatedAt           time.Time
	TerminalAt          *time.Time
}

// SagaUpdate only permits filling facts that have been independently observed
// during the next stage. It intentionally has no field for tenant, intent,
// idempotency key, payload hash, amount, direction, asset, or fiat because
// those bindings may never change after Reserve succeeds.
type SagaUpdate struct {
	RouteID             string
	ProviderReference   string
	CustodyReference    string
	BlockchainTx        string
	LedgerPendingID     uint64
	LedgerTransferID    uint64
	AttestationID       string
	FailureClass        string
	ReconciliationRunID string
	Reason              string
}

// SagaStore is the durable coordinator boundary. Reserve must bind an intent,
// idempotency key and canonical payload digest atomically before side effects.
// Every Advance persists state, transition evidence, and an outbox event in the
// same PostgreSQL transaction.
type SagaStore interface {
	Reserve(context.Context, Intent, string) (SettlementRecord, bool, error)
	Advance(context.Context, SettlementRecord, ExecutionStage, SagaUpdate) (SettlementRecord, error)
	MarkHeld(context.Context, SettlementRecord, string) error
	MarkUnknown(context.Context, SettlementRecord, string) error
	Load(context.Context, string, string) (SettlementRecord, error)
}

// OutboxEvent is leased by a publisher and delivered to Kafka, Temporal,
// Dapr, Fluvio, or another middleware transport. Broker acknowledgement is
// not permitted to mutate a saga without the matching inbox reservation.
type OutboxEvent struct {
	TenantID            string
	EventID             string
	SagaID              string
	Stage               ExecutionStage
	EventType           string
	Payload             json.RawMessage
	PayloadSHA256       string
	ReconciliationRunID string
	AvailableAt         time.Time
	LeasedUntil         *time.Time
	LeaseOwner          string
	AttemptCount        int
}

// PostgresSagaStore uses a tenant-local transaction setting on every request.
// It is deliberately independent from the older reconciliation store so the
// coordinator can own all pre- and post-side-effect states.
type PostgresSagaStore struct {
	DB  *sql.DB
	Now func() time.Time
}

func (s *PostgresSagaStore) now() time.Time {
	if s != nil && s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func (s *PostgresSagaStore) tx(ctx context.Context, tenantID string) (*sql.Tx, error) {
	if s == nil || s.DB == nil {
		return nil, errors.New("PostgreSQL saga store is required")
	}
	if strings.TrimSpace(tenantID) == "" {
		return nil, errors.New("tenant id is required")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `SELECT set_config('umoja.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback()
		return nil, fmt.Errorf("bind PostgreSQL tenant context: %w", err)
	}
	return tx, nil
}

func validDigest(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func sagaID(tenantID, idempotencyKey, payloadSHA256 string) string {
	sum := sha256.Sum256([]byte(tenantID + "\x00" + idempotencyKey + "\x00" + payloadSHA256))
	return hex.EncodeToString(sum[:])
}

func sagaEventID(sagaID string, version int64) string {
	sum := sha256.Sum256([]byte(sagaID + "\x00" + fmt.Sprintf("%d", version)))
	return hex.EncodeToString(sum[:])
}

func stageAllows(from, to ExecutionStage) bool {
	if to == StageHeld || to == StageUnknown {
		return from != StageSettled && from != StageHeld && from != StageUnknown
	}
	switch from {
	case StageReceived:
		return to == StageScreened
	case StageScreened:
		return to == StageRouted
	case StageRouted:
		return to == StageLiquidityReserved
	case StageLiquidityReserved:
		return to == StageLedgerPrepared
	case StageLedgerPrepared:
		return to == StageFiatSubmitted || to == StageCustodySubmitted
	case StageFiatSubmitted:
		return to == StageCustodySubmitted
	case StageCustodySubmitted:
		return to == StageFinalityConfirmed || to == StageFiatSubmitted
	case StageFinalityConfirmed:
		return to == StageLedgerCommitted || to == StageFiatSubmitted
	case StageLedgerCommitted:
		return to == StageAttestationVerified
	case StageAttestationVerified:
		return to == StageSettled
	default:
		return false
	}
}

// stageAllowsRecord adds directional preconditions that cannot be represented
// by a stage label alone. In particular, an off-ramp reaches fiat submission
// after finality, while an on-ramp reaches it before custody submission.
func stageAllowsRecord(record SettlementRecord, to ExecutionStage) bool {
	if record.Stage == StageLedgerPrepared {
		return (record.Direction == Onramp && to == StageFiatSubmitted) || (record.Direction == Offramp && to == StageCustodySubmitted) || to == StageHeld || to == StageUnknown
	}
	if record.Stage == StageFiatSubmitted && to == StageLedgerCommitted {
		return record.Direction == Offramp && record.CustodyReference != "" && record.BlockchainTx != ""
	}
	if record.Stage == StageFiatSubmitted && to == StageCustodySubmitted {
		return record.Direction == Onramp
	}
	if record.Stage == StageFinalityConfirmed && to == StageLedgerCommitted {
		return record.Direction == Onramp
	}
	if record.Stage == StageFinalityConfirmed && to == StageFiatSubmitted {
		return record.Direction == Offramp
	}
	return stageAllows(record.Stage, to)
}

func terminalStage(stage ExecutionStage) bool {
	return stage == StageSettled || stage == StageHeld || stage == StageUnknown
}

func validateReservedIntent(in Intent, digest string) error {
	if err := validateIntent(in); err != nil {
		return err
	}
	if !validDigest(digest) {
		return errors.New("canonical payload SHA-256 is required")
	}
	return nil
}

func (s *PostgresSagaStore) Reserve(ctx context.Context, in Intent, digest string) (SettlementRecord, bool, error) {
	if err := validateReservedIntent(in, digest); err != nil {
		return SettlementRecord{}, false, err
	}
	tx, err := s.tx(ctx, in.TenantID)
	if err != nil {
		return SettlementRecord{}, false, err
	}
	defer tx.Rollback()

	now := s.now()
	id := sagaID(in.TenantID, in.IdempotencyKey, digest)
	row := tx.QueryRowContext(ctx, `
		INSERT INTO settlement_saga (
			tenant_id,saga_id,intent_id,idempotency_key,payload_sha256,direction,asset,fiat,amount_minor,destination,stage,version,created_at,updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$12)
		ON CONFLICT (tenant_id,idempotency_key) DO NOTHING
			RETURNING tenant_id,saga_id,intent_id,idempotency_key,payload_sha256,direction,asset,fiat,amount_minor,destination,stage,version,created_at,updated_at,ledger_pending_id,ledger_transfer_id,terminal_at`,
		in.TenantID, id, in.ID, in.IdempotencyKey, digest, string(in.Direction), in.Asset, in.Fiat, in.AmountMinor, in.Destination, string(StageReceived), now,
	)
	record, scanErr := scanSaga(row)
	if scanErr == nil {
		if err := s.insertTransitionAndOutbox(ctx, tx, record, "", StageReceived, "intent reserved"); err != nil {
			return SettlementRecord{}, false, err
		}
		if err := tx.Commit(); err != nil {
			return SettlementRecord{}, false, err
		}
		return record, true, nil
	}
	if !errors.Is(scanErr, sql.ErrNoRows) {
		return SettlementRecord{}, false, scanErr
	}
	record, err = loadSagaForUpdate(ctx, tx, in.TenantID, in.IdempotencyKey)
	if err != nil {
		return SettlementRecord{}, false, err
	}
	if record.IntentID != in.ID || record.PayloadSHA256 != digest {
		return SettlementRecord{}, false, ErrSagaPayloadChanged
	}
	if err := tx.Commit(); err != nil {
		return SettlementRecord{}, false, err
	}
	return record, false, nil
}

func scanSaga(row interface{ Scan(...any) error }) (SettlementRecord, error) {
	var out SettlementRecord
	var direction string
	var pendingID, transferID sql.NullInt64
	var terminalAt sql.NullTime
	err := row.Scan(
		&out.TenantID, &out.SagaID, &out.IntentID, &out.IdempotencyKey, &out.PayloadSHA256,
		&direction, &out.Asset, &out.Fiat, &out.AmountMinor, &out.Destination, &out.Stage,
		&out.Version, &out.CreatedAt, &out.UpdatedAt, &terminalAt,
	)
	if err != nil {
		return SettlementRecord{}, err
	}
	out.Direction = Direction(direction)
	if pendingID.Valid && pendingID.Int64 > 0 {
		out.LedgerPendingID = uint64(pendingID.Int64)
	}
	if transferID.Valid && transferID.Int64 > 0 {
		out.LedgerTransferID = uint64(transferID.Int64)
	}
	if terminalAt.Valid {
		v := terminalAt.Time.UTC()
		out.TerminalAt = &v
	}
	return out, nil
}

func loadSagaForUpdate(ctx context.Context, tx *sql.Tx, tenantID, idempotencyKey string) (SettlementRecord, error) {
	var out SettlementRecord
	var direction string
	var pendingID, transferID sql.NullInt64
	var terminalAt sql.NullTime
	err := tx.QueryRowContext(ctx, `
		SELECT tenant_id,saga_id,intent_id,idempotency_key,payload_sha256,direction,asset,fiat,amount_minor,destination,stage,
		       COALESCE(route_id,''),COALESCE(provider_reference,''),COALESCE(custody_reference,''),COALESCE(blockchain_tx,''),
		       ledger_pending_id,ledger_transfer_id,COALESCE(attestation_id,''),COALESCE(failure_class,''),COALESCE(reconciliation_run_id,''),
		       version,created_at,updated_at,terminal_at
		FROM settlement_saga
		WHERE tenant_id=$1 AND idempotency_key=$2
		FOR UPDATE`, tenantID, idempotencyKey,
	).Scan(
		&out.TenantID, &out.SagaID, &out.IntentID, &out.IdempotencyKey, &out.PayloadSHA256, &direction, &out.Asset, &out.Fiat, &out.AmountMinor, &out.Destination, &out.Stage,
		&out.RouteID, &out.ProviderReference, &out.CustodyReference, &out.BlockchainTx, &pendingID, &transferID, &out.AttestationID, &out.FailureClass, &out.ReconciliationRunID,
		&out.Version, &out.CreatedAt, &out.UpdatedAt, &terminalAt,
	)
	if err != nil {
		return SettlementRecord{}, err
	}
	out.Direction = Direction(direction)
	if pendingID.Valid && pendingID.Int64 > 0 {
		out.LedgerPendingID = uint64(pendingID.Int64)
	}
	if transferID.Valid && transferID.Int64 > 0 {
		out.LedgerTransferID = uint64(transferID.Int64)
	}
	if terminalAt.Valid {
		value := terminalAt.Time.UTC()
		out.TerminalAt = &value
	}
	return out, nil
}

func (s *PostgresSagaStore) Load(ctx context.Context, tenantID, idempotencyKey string) (SettlementRecord, error) {
	tx, err := s.tx(ctx, tenantID)
	if err != nil {
		return SettlementRecord{}, err
	}
	defer tx.Rollback()
	record, err := loadSagaForUpdate(ctx, tx, tenantID, idempotencyKey)
	if err != nil {
		return SettlementRecord{}, err
	}
	if err := tx.Commit(); err != nil {
		return SettlementRecord{}, err
	}
	return record, nil
}

func recordWithUpdate(record SettlementRecord, stage ExecutionStage, update SagaUpdate, now time.Time) SettlementRecord {
	record.Stage = stage
	record.Version++
	record.UpdatedAt = now
	if update.RouteID != "" {
		record.RouteID = update.RouteID
	}
	if update.ProviderReference != "" {
		record.ProviderReference = update.ProviderReference
	}
	if update.CustodyReference != "" {
		record.CustodyReference = update.CustodyReference
	}
	if update.BlockchainTx != "" {
		record.BlockchainTx = update.BlockchainTx
	}
	if update.LedgerPendingID != 0 {
		record.LedgerPendingID = update.LedgerPendingID
	}
	if update.LedgerTransferID != 0 {
		record.LedgerTransferID = update.LedgerTransferID
	}
	if update.AttestationID != "" {
		record.AttestationID = update.AttestationID
	}
	if update.FailureClass != "" {
		record.FailureClass = update.FailureClass
	}
	if update.ReconciliationRunID != "" {
		record.ReconciliationRunID = update.ReconciliationRunID
	}
	if terminalStage(stage) {
		value := now
		record.TerminalAt = &value
	}
	return record
}

func (s *PostgresSagaStore) Advance(ctx context.Context, current SettlementRecord, next ExecutionStage, update SagaUpdate) (SettlementRecord, error) {
	if strings.TrimSpace(current.TenantID) == "" || strings.TrimSpace(current.IdempotencyKey) == "" || current.Version <= 0 {
		return SettlementRecord{}, errors.New("tenant, idempotency key, and saga version are required")
	}
	if !stageAllowsRecord(current, next) {
		if terminalStage(current.Stage) {
			return SettlementRecord{}, ErrSagaTerminal
		}
		return SettlementRecord{}, fmt.Errorf("%w: %s -> %s", ErrSagaConflict, current.Stage, next)
	}
	tx, err := s.tx(ctx, current.TenantID)
	if err != nil {
		return SettlementRecord{}, err
	}
	defer tx.Rollback()
	locked, err := loadSagaForUpdate(ctx, tx, current.TenantID, current.IdempotencyKey)
	if err != nil {
		return SettlementRecord{}, err
	}
	if locked.SagaID != current.SagaID || locked.PayloadSHA256 != current.PayloadSHA256 || locked.Version != current.Version || locked.Stage != current.Stage {
		return SettlementRecord{}, ErrSagaConflict
	}
	now := s.now()
	nextRecord := recordWithUpdate(locked, next, update, now)
	result, err := tx.ExecContext(ctx, `
		UPDATE settlement_saga SET
		 stage=$1,route_id=NULLIF($2,''),provider_reference=NULLIF($3,''),custody_reference=NULLIF($4,''),blockchain_tx=NULLIF($5,''),
		 ledger_pending_id=NULLIF($6,0),ledger_transfer_id=NULLIF($7,0),attestation_id=NULLIF($8,''),failure_class=NULLIF($9,''),
		 reconciliation_run_id=NULLIF($10,''),version=$11,terminal_at=$12,updated_at=$13
		WHERE tenant_id=$14 AND saga_id=$15 AND version=$16 AND stage=$17`,
		string(nextRecord.Stage), nextRecord.RouteID, nextRecord.ProviderReference, nextRecord.CustodyReference, nextRecord.BlockchainTx,
		nextRecord.LedgerPendingID, nextRecord.LedgerTransferID, nextRecord.AttestationID, nextRecord.FailureClass, nextRecord.ReconciliationRunID,
		nextRecord.Version, nextRecord.TerminalAt, now, current.TenantID, current.SagaID, current.Version, string(current.Stage),
	)
	if err != nil {
		return SettlementRecord{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return SettlementRecord{}, ErrSagaConflict
	}
	if err := s.insertTransitionAndOutbox(ctx, tx, nextRecord, current.Stage, next, update.Reason); err != nil {
		return SettlementRecord{}, err
	}
	if err := tx.Commit(); err != nil {
		return SettlementRecord{}, err
	}
	return nextRecord, nil
}

func (s *PostgresSagaStore) MarkHeld(ctx context.Context, record SettlementRecord, reason string) error {
	if record.Stage == StageHeld {
		return nil
	}
	_, err := s.Advance(ctx, record, StageHeld, SagaUpdate{FailureClass: "held", Reason: reason})
	return err
}

func (s *PostgresSagaStore) MarkUnknown(ctx context.Context, record SettlementRecord, reason string) error {
	if record.Stage == StageUnknown {
		return nil
	}
	_, err := s.Advance(ctx, record, StageUnknown, SagaUpdate{FailureClass: "unknown", Reason: reason})
	return err
}

func (s *PostgresSagaStore) insertTransitionAndOutbox(ctx context.Context, tx *sql.Tx, record SettlementRecord, from, to ExecutionStage, reason string) error {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO settlement_saga_transition (tenant_id,saga_id,version,from_stage,to_stage,reason,payload_sha256,created_at)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,NULLIF($6,''),$7,$8)`,
		record.TenantID, record.SagaID, record.Version, string(from), string(to), reason, record.PayloadSHA256, record.UpdatedAt,
	); err != nil {
		return fmt.Errorf("record saga transition: %w", err)
	}
	payload, err := json.Marshal(map[string]any{
		"schema_version": "v1", "tenant_id": record.TenantID, "saga_id": record.SagaID,
		"intent_id": record.IntentID, "stage": record.Stage, "version": record.Version,
		"payload_sha256": record.PayloadSHA256, "reconciliation_run_id": record.ReconciliationRunID,
	})
	if err != nil {
		return err
	}
	digest := sha256.Sum256(payload)
	_, err = tx.ExecContext(ctx, `
		INSERT INTO settlement_outbox (tenant_id,event_id,saga_id,stage,event_type,payload,payload_sha256,reconciliation_run_id,available_at,created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),$9,$9)`,
		record.TenantID, sagaEventID(record.SagaID, record.Version), record.SagaID, string(record.Stage), "umojaflowos.settlement.saga-transition.v1", payload, hex.EncodeToString(digest[:]), record.ReconciliationRunID, record.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("write settlement outbox: %w", err)
	}
	return nil
}

// ReserveInbox atomically deduplicates a middleware delivery. A repeated ID
// carrying a different payload is a security error, not a harmless duplicate.
func (s *PostgresSagaStore) ReserveInbox(ctx context.Context, tenantID, source, messageID, sagaID, payloadSHA256 string) (bool, error) {
	if strings.TrimSpace(source) == "" || strings.TrimSpace(messageID) == "" || !validDigest(payloadSHA256) {
		return false, errors.New("source, message id, and payload SHA-256 are required")
	}
	tx, err := s.tx(ctx, tenantID)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
		INSERT INTO settlement_inbox (tenant_id,source,message_id,saga_id,payload_sha256,received_at)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,$6)
		ON CONFLICT (tenant_id,source,message_id) DO NOTHING`, tenantID, source, messageID, sagaID, payloadSHA256, s.now(),
	)
	if err != nil {
		return false, err
	}
	if affected, _ := result.RowsAffected(); affected == 1 {
		if err := tx.Commit(); err != nil {
			return false, err
		}
		return true, nil
	}
	var stored string
	if err := tx.QueryRowContext(ctx, `SELECT payload_sha256 FROM settlement_inbox WHERE tenant_id=$1 AND source=$2 AND message_id=$3 FOR UPDATE`, tenantID, source, messageID).Scan(&stored); err != nil {
		return false, err
	}
	if stored != payloadSHA256 {
		return false, ErrInboxPayloadChanged
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return false, nil
}

func (s *PostgresSagaStore) MarkInboxProcessed(ctx context.Context, tenantID, source, messageID string) error {
	tx, err := s.tx(ctx, tenantID)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
		UPDATE settlement_inbox SET processed_at=$1,processing_error=NULL
		WHERE tenant_id=$2 AND source=$3 AND message_id=$4 AND processed_at IS NULL`, s.now(), tenantID, source, messageID,
	)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrSagaConflict
	}
	return tx.Commit()
}

// ClaimOutbox leases a bounded batch using SKIP LOCKED. Each lease is scoped to
// a tenant so workers cannot observe another tenant's event queue.
func (s *PostgresSagaStore) ClaimOutbox(ctx context.Context, tenantID, owner string, limit int, lease time.Duration) ([]OutboxEvent, error) {
	if strings.TrimSpace(owner) == "" || limit <= 0 || limit > 1000 || lease <= 0 {
		return nil, errors.New("owner, bounded limit, and positive lease are required")
	}
	tx, err := s.tx(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	now := s.now()
	leaseUntil := now.Add(lease)
	rows, err := tx.QueryContext(ctx, `
		WITH eligible AS (
		  SELECT tenant_id,event_id FROM settlement_outbox
		  WHERE tenant_id=$1 AND published_at IS NULL AND available_at <= $2
		    AND (leased_until IS NULL OR leased_until < $2)
		  ORDER BY created_at
		  FOR UPDATE SKIP LOCKED
		  LIMIT $3
		)
		UPDATE settlement_outbox o SET lease_owner=$4,leased_until=$5,attempt_count=o.attempt_count+1
		FROM eligible e WHERE o.tenant_id=e.tenant_id AND o.event_id=e.event_id
		RETURNING o.tenant_id,o.event_id,o.saga_id,o.stage,o.event_type,o.payload,o.payload_sha256,COALESCE(o.reconciliation_run_id,''),o.available_at,o.leased_until,o.lease_owner,o.attempt_count`,
		tenantID, now, limit, owner, leaseUntil,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []OutboxEvent
	for rows.Next() {
		var event OutboxEvent
		var stage string
		var leased sql.NullTime
		if err := rows.Scan(&event.TenantID, &event.EventID, &event.SagaID, &stage, &event.EventType, &event.Payload, &event.PayloadSHA256, &event.ReconciliationRunID, &event.AvailableAt, &leased, &event.LeaseOwner, &event.AttemptCount); err != nil {
			return nil, err
		}
		event.Stage = ExecutionStage(stage)
		if leased.Valid {
			value := leased.Time.UTC()
			event.LeasedUntil = &value
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return events, nil
}

func (s *PostgresSagaStore) MarkOutboxPublished(ctx context.Context, tenantID, eventID, owner string) error {
	if strings.TrimSpace(eventID) == "" || strings.TrimSpace(owner) == "" {
		return errors.New("event id and lease owner are required")
	}
	tx, err := s.tx(ctx, tenantID)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
		UPDATE settlement_outbox SET published_at=$1,leased_until=NULL,lease_owner=NULL
		WHERE tenant_id=$2 AND event_id=$3 AND lease_owner=$4 AND published_at IS NULL`, s.now(), tenantID, eventID, owner,
	)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrSagaConflict
	}
	return tx.Commit()
}
