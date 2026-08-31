package multirail

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

var (
	ErrStoreNotConfigured = errors.New("postgres reconciliation store is not configured")
	ErrIdempotencyBinding = errors.New("idempotency key is bound to different intent evidence")
	ErrLeaseLost          = errors.New("reconciliation worker lease is no longer owned")
	ErrDecisionConflict   = errors.New("reconciliation decision conflicts with existing immutable evidence")
)

// PostgresUnknownStateStore uses database/sql so the application can select its
// PostgreSQL driver at process startup. It never opens provider connections and
// never performs payment execution.
type PostgresUnknownStateStore struct {
	DB            *sql.DB
	LeaseDuration time.Duration
}

func (s *PostgresUnknownStateStore) validate() error {
	if s == nil || s.DB == nil {
		return ErrStoreNotConfigured
	}
	if s.LeaseDuration <= 0 {
		s.LeaseDuration = 2 * time.Minute
	}
	return nil
}

func payloadDigest(payload []byte) string {
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

func newLeaseToken() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// EnqueueUnknown persists the original instruction exactly once. A conflicting
// idempotency key is accepted only when its intent digest matches.
func (s *PostgresUnknownStateStore) EnqueueUnknown(ctx context.Context, state UnknownState) error {
	if err := s.validate(); err != nil {
		return err
	}
	if state.Intent.ID == "" || state.Intent.IdempotencyKey == "" || len(state.Intent.Payload) == 0 {
		return errors.New("intent id, idempotency key, and canonical payload are required")
	}
	digest := payloadDigest(state.Intent.Payload)
	now := time.Now().UTC()
	if !state.NextAttemptAt.IsZero() {
		now = state.NextAttemptAt.UTC()
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	result, err := tx.ExecContext(ctx, `
		INSERT INTO provider_unknown_reconciliation
		(idempotency_key, intent_id, primary_rail, provider_reference, observed_status,
		 attempts, next_attempt_at, intent_asset, intent_fiat, intent_amount_minor,
		 intent_expires_at, intent_payload, intent_digest, updated_at)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,0,$6,$7,$8,$9,NULLIF($10,'')::timestamptz,$11::jsonb,$12,$6)
		ON CONFLICT (idempotency_key) DO NOTHING`,
		state.Intent.IdempotencyKey, state.Intent.ID, state.PrimaryRail, state.ProviderRef,
		statusOrUnknown(state.ObservedStatus), now, state.Intent.Asset, state.Intent.Fiat,
		state.Intent.AmountMinor, formatTime(state.Intent.ExpiresAt), string(state.Intent.Payload), digest)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		var existingIntent, existingDigest string
		err = tx.QueryRowContext(ctx, `SELECT intent_id, intent_digest FROM provider_unknown_reconciliation WHERE idempotency_key=$1`, state.Intent.IdempotencyKey).Scan(&existingIntent, &existingDigest)
		if err != nil {
			return err
		}
		if existingIntent != state.Intent.ID || existingDigest != digest {
			return ErrIdempotencyBinding
		}
	}
	return tx.Commit()
}

// Claim atomically increments attempts and takes a lease. SKIP LOCKED is not
// needed here because the UPDATE predicate itself is the compare-and-set gate;
// PostgreSQL row locking serializes competing updates.
func (s *PostgresUnknownStateStore) Claim(ctx context.Context, key string, now time.Time) (UnknownState, bool, error) {
	if err := s.validate(); err != nil {
		return UnknownState{}, false, err
	}
	lease, err := newLeaseToken()
	if err != nil {
		return UnknownState{}, false, err
	}
	leaseUntil := now.UTC().Add(s.LeaseDuration)
	var state UnknownState
	var payload []byte
	var expiresAt sql.NullTime
	var nextAttempt, leaseEnd time.Time
	var providerRef, digest, leaseToken string
	var amountMinor sql.NullInt64
	var attempts int
	err = s.DB.QueryRowContext(ctx, `
		UPDATE provider_unknown_reconciliation
		   SET attempts=attempts+1, lease_until=$2, lease_token=$3::uuid, updated_at=$1
		 WHERE idempotency_key=$4 AND resolved_at IS NULL
		   AND next_attempt_at <= $1
		   AND (lease_until IS NULL OR lease_until <= $1)
		 RETURNING intent_id::text, idempotency_key, primary_rail, COALESCE(provider_reference,''),
		           observed_status, attempts, next_attempt_at, COALESCE(lease_until,$2),
			   COALESCE(intent_asset,''), COALESCE(intent_fiat,''), intent_amount_minor,
			   intent_expires_at, intent_payload, intent_digest, lease_token::text`,
		now.UTC(), leaseUntil, lease, key).Scan(
		&state.Intent.ID, &state.Intent.IdempotencyKey, &state.PrimaryRail, &providerRef,
		&state.ObservedStatus, &attempts, &nextAttempt, &leaseEnd, &state.Intent.Asset,
		&state.Intent.Fiat, &amountMinor, &expiresAt, &payload, &digest, &leaseToken)
	if errors.Is(err, sql.ErrNoRows) {
		return UnknownState{}, false, nil
	}
	if err != nil {
		return UnknownState{}, false, err
	}
	state.ProviderRef = providerRef
	state.Intent.Payload = payload
	if amountMinor.Valid {
		state.Intent.AmountMinor = amountMinor.Int64
	}
	if expiresAt.Valid {
		state.Intent.ExpiresAt = expiresAt.Time
	}
	state.LeaseToken = leaseToken
	state.ObservedStatus = statusOrUnknown(state.ObservedStatus)
	state.Attempts = attempts
	state.NextAttemptAt = nextAttempt
	state.LastError = ""
	_ = leaseEnd
	_ = digest
	return state, true, nil
}

func (s *PostgresUnknownStateStore) Reschedule(ctx context.Context, state UnknownState, next time.Time, reason string) error {
	if err := s.validate(); err != nil {
		return err
	}
	result, err := s.DB.ExecContext(ctx, `
		UPDATE provider_unknown_reconciliation
		   SET next_attempt_at=$1, last_error=$2, lease_until=NULL, lease_token=NULL, updated_at=$1
		 WHERE idempotency_key=$3 AND attempts=$4 AND lease_token=$5::uuid AND resolved_at IS NULL`,
		next.UTC(), reason, state.Intent.IdempotencyKey, state.Attempts, state.LeaseToken)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected != 1 {
		return ErrLeaseLost
	}
	return nil
}

func (s *PostgresUnknownStateStore) RecordDecision(ctx context.Context, result ReconciliationResult) error {
	if err := s.validate(); err != nil {
		return err
	}
	if result.SettlementAllowed || result.IdempotencyKey == "" || result.Attempt <= 0 || result.EvidenceDigest == "" {
		return errors.New("invalid fail-closed reconciliation decision")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var insertedID string
	err = tx.QueryRowContext(ctx, `
		INSERT INTO provider_reconciliation_decision
		(idempotency_key, intent_id, primary_rail, provider_reference, decision,
		 observed_status, settlement_allowed, attempt, reason, evidence_digest, decided_at)
		VALUES ($1,$2,$3,NULLIF($4,''),$5,$6,false,$7,$8,$9,$10)
		ON CONFLICT DO NOTHING
		RETURNING id::text`,
		result.IdempotencyKey, result.IntentID, result.PrimaryRail, result.ProviderRef,
		result.Decision, string(result.ObservedStatus), result.Attempt, result.Reason,
		result.EvidenceDigest, result.DecidedAt.UTC()).Scan(&insertedID)
	if errors.Is(err, sql.ErrNoRows) {
		var existingDigest string
		err = tx.QueryRowContext(ctx, `SELECT evidence_digest FROM provider_reconciliation_decision WHERE idempotency_key=$1 AND attempt=$2`, result.IdempotencyKey, result.Attempt).Scan(&existingDigest)
		if err != nil || existingDigest != result.EvidenceDigest {
			return ErrDecisionConflict
		}
	}
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		UPDATE provider_unknown_reconciliation
		   SET resolved_at=$1, lease_until=NULL, lease_token=NULL, updated_at=$1
		 WHERE idempotency_key=$2 AND attempts=$3 AND lease_token=$4::uuid AND resolved_at IS NULL`,
		result.DecidedAt.UTC(), result.IdempotencyKey, result.Attempt, result.LeaseToken)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func formatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}

func statusOrUnknown(status Status) Status {
	if status == "" {
		return Unknown
	}
	return status
}

func normalizeStatus(value string) Status {
	return statusOrUnknown(Status(value))
}
