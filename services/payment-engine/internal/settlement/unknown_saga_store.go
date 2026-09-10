package settlement

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

var (
	ErrUnknownSagaNotLeased = errors.New("UNKNOWN settlement saga is not leased by this reconciliation worker")
	ErrResolutionApproval   = errors.New("valid settlement resolution authorization is required")
)

// ResolutionAuthorization is written by the independent approval service only
// after it verifies the four-role release manifest and external PKI evidence.
// A reconciliation worker can read and consume it once but cannot create it.
type ResolutionAuthorization struct {
	TenantID            string
	SagaID              string
	AuthorizationID     string
	Decision            string // commit, void, or hold
	ReleaseSHA          string
	ManifestSHA256      string
	ReconciliationRunID string
	EvidenceSHA256      string
	ExpiresAt           time.Time
}

type UnknownSagaStore interface {
	ClaimUnknownSagas(context.Context, string, string, int, time.Duration) ([]SettlementRecord, error)
	FindResolutionAuthorization(context.Context, string, string, string) (ResolutionAuthorization, bool, error)
	ResolveUnknownSaga(context.Context, SettlementRecord, string, ResolutionAuthorization, SagaUpdate) (SettlementRecord, error)
}

// ClaimUnknownSagas uses SKIP LOCKED and a bounded, expiring lease. It never
// changes the UNKNOWN stage; an unresolved row remains fail-closed on lease
// expiry and may be retried only by reconciliation.
func (s *PostgresSagaStore) ClaimUnknownSagas(ctx context.Context, tenantID, owner string, limit int, lease time.Duration) ([]SettlementRecord, error) {
	if strings.TrimSpace(owner) == "" || limit <= 0 || limit > 1000 || lease <= 0 {
		return nil, errors.New("worker owner, bounded limit, and positive lease are required")
	}
	tx, err := s.tx(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	now := s.now()
	until := now.Add(lease)
	rows, err := tx.QueryContext(ctx, `
		WITH eligible AS (
		  SELECT tenant_id,saga_id FROM settlement_saga
		  WHERE tenant_id=$1 AND stage='unknown'
		    AND (resolution_leased_until IS NULL OR resolution_leased_until < $2)
		  ORDER BY updated_at
		  FOR UPDATE SKIP LOCKED LIMIT $3
		)
		UPDATE settlement_saga s SET resolution_lease_owner=$4,resolution_leased_until=$5,reconciliation_attempt_count=s.reconciliation_attempt_count+1
		FROM eligible e WHERE s.tenant_id=e.tenant_id AND s.saga_id=e.saga_id
		RETURNING s.idempotency_key`, tenantID, now, limit, owner, until)
	if err != nil {
		return nil, err
	}
	var keys []string
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return nil, err
		}
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	out := make([]SettlementRecord, 0, len(keys))
	for _, key := range keys {
		record, err := s.Load(ctx, tenantID, key)
		if err != nil {
			return nil, err
		}
		out = append(out, record)
	}
	return out, nil
}

func (s *PostgresSagaStore) FindResolutionAuthorization(ctx context.Context, tenantID, sagaID, decision string) (ResolutionAuthorization, bool, error) {
	if decision != "commit" && decision != "void" && decision != "hold" {
		return ResolutionAuthorization{}, false, ErrResolutionApproval
	}
	tx, err := s.tx(ctx, tenantID)
	if err != nil {
		return ResolutionAuthorization{}, false, err
	}
	defer tx.Rollback()
	var a ResolutionAuthorization
	err = tx.QueryRowContext(ctx, `
		SELECT tenant_id,saga_id,authorization_id,decision,release_sha,manifest_sha256,reconciliation_run_id,evidence_sha256,expires_at
		FROM settlement_unknown_resolution_authorization
		WHERE tenant_id=$1 AND saga_id=$2 AND decision=$3 AND consumed_at IS NULL AND expires_at > $4
		ORDER BY issued_at LIMIT 1`, tenantID, sagaID, decision, s.now()).Scan(&a.TenantID, &a.SagaID, &a.AuthorizationID, &a.Decision, &a.ReleaseSHA, &a.ManifestSHA256, &a.ReconciliationRunID, &a.EvidenceSHA256, &a.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ResolutionAuthorization{}, false, tx.Commit()
	}
	if err != nil {
		return ResolutionAuthorization{}, false, err
	}
	if !validResolutionAuthorization(a, tenantID, sagaID, decision, s.now()) {
		return ResolutionAuthorization{}, false, ErrResolutionApproval
	}
	if err := tx.Commit(); err != nil {
		return ResolutionAuthorization{}, false, err
	}
	return a, true, nil
}

func validResolutionAuthorization(a ResolutionAuthorization, tenantID, sagaID, decision string, now time.Time) bool {
	return a.TenantID == tenantID && a.SagaID == sagaID && a.Decision == decision && strings.TrimSpace(a.AuthorizationID) != "" && validLowerHex(a.ReleaseSHA, 40) && validDigest(a.ManifestSHA256) && validDigest(a.EvidenceSHA256) && len(strings.TrimSpace(a.ReconciliationRunID)) >= 8 && a.ExpiresAt.After(now)
}

func validLowerHex(value string, length int) bool {
	if len(value) != length {
		return false
	}
	for _, c := range value {
		if !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// ResolveUnknownSaga consumes one authorization in the same PostgreSQL
// transaction as terminal saga state, immutable transition evidence, and the
// outgoing event. A worker that loses its lease cannot resolve the saga.
func (s *PostgresSagaStore) ResolveUnknownSaga(ctx context.Context, current SettlementRecord, owner string, authorization ResolutionAuthorization, update SagaUpdate) (SettlementRecord, error) {
	if strings.TrimSpace(owner) == "" || current.Stage != StageUnknown {
		return SettlementRecord{}, ErrUnknownSagaNotLeased
	}
	if authorization.Decision != "commit" && authorization.Decision != "void" && authorization.Decision != "hold" {
		return SettlementRecord{}, ErrResolutionApproval
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
	if locked.SagaID != current.SagaID || locked.Stage != StageUnknown || locked.Version != current.Version {
		return SettlementRecord{}, ErrSagaConflict
	}
	var authorizationID string
	err = tx.QueryRowContext(ctx, `
		SELECT authorization_id FROM settlement_unknown_resolution_authorization
		WHERE tenant_id=$1 AND saga_id=$2 AND authorization_id=$3 AND decision=$4 AND release_sha=$5 AND manifest_sha256=$6 AND reconciliation_run_id=$7 AND evidence_sha256=$8 AND consumed_at IS NULL AND expires_at>$9
		FOR UPDATE`, authorization.TenantID, authorization.SagaID, authorization.AuthorizationID, authorization.Decision, authorization.ReleaseSHA, authorization.ManifestSHA256, authorization.ReconciliationRunID, authorization.EvidenceSHA256, s.now()).Scan(&authorizationID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return SettlementRecord{}, ErrResolutionApproval
		}
		return SettlementRecord{}, err
	}
	var leaseOwner string
	var leased sql.NullTime
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(resolution_lease_owner,''),resolution_leased_until FROM settlement_saga WHERE tenant_id=$1 AND saga_id=$2 FOR UPDATE`, locked.TenantID, locked.SagaID).Scan(&leaseOwner, &leased); err != nil {
		return SettlementRecord{}, err
	}
	if leaseOwner != owner || !leased.Valid || !leased.Time.After(s.now()) {
		return SettlementRecord{}, ErrUnknownSagaNotLeased
	}
	next := StageHeld
	if authorization.Decision == "commit" {
		next = StageSettled
	}
	update.ReconciliationRunID = authorization.ReconciliationRunID
	update.Reason = "authorized UNKNOWN reconciliation: " + authorization.Decision
	nextRecord := recordWithUpdate(locked, next, update, s.now())
	result, err := tx.ExecContext(ctx, `UPDATE settlement_saga SET stage=$1,provider_reference=NULLIF($2,''),custody_reference=NULLIF($3,''),blockchain_tx=NULLIF($4,''),ledger_pending_id=NULLIF($5,0),ledger_transfer_id=NULLIF($6,0),attestation_id=NULLIF($7,''),failure_class=NULLIF($8,''),reconciliation_run_id=$9,version=$10,terminal_at=$11,updated_at=$12,resolution_lease_owner=NULL,resolution_leased_until=NULL WHERE tenant_id=$13 AND saga_id=$14 AND stage='unknown' AND version=$15 AND resolution_lease_owner=$16`, string(nextRecord.Stage), nextRecord.ProviderReference, nextRecord.CustodyReference, nextRecord.BlockchainTx, nextRecord.LedgerPendingID, nextRecord.LedgerTransferID, nextRecord.AttestationID, nextRecord.FailureClass, nextRecord.ReconciliationRunID, nextRecord.Version, nextRecord.TerminalAt, nextRecord.UpdatedAt, locked.TenantID, locked.SagaID, locked.Version, owner)
	if err != nil {
		return SettlementRecord{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return SettlementRecord{}, ErrSagaConflict
	}
	if err := s.insertTransitionAndOutbox(ctx, tx, nextRecord, StageUnknown, next, update.Reason); err != nil {
		return SettlementRecord{}, err
	}
	result, err = tx.ExecContext(ctx, `UPDATE settlement_unknown_resolution_authorization SET consumed_at=$1,consumed_by=$2 WHERE tenant_id=$3 AND saga_id=$4 AND authorization_id=$5 AND consumed_at IS NULL`, s.now(), owner, locked.TenantID, locked.SagaID, authorizationID)
	if err != nil {
		return SettlementRecord{}, err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return SettlementRecord{}, ErrResolutionApproval
	}
	if err := tx.Commit(); err != nil {
		return SettlementRecord{}, err
	}
	return nextRecord, nil
}

var _ UnknownSagaStore = (*PostgresSagaStore)(nil)
