package fencestore

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/ledger"
	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/reconciliation"
)

var (
	ErrNotConfigured  = errors.New("settlement fence command store is not configured")
	ErrReplayConflict = errors.New("settlement fence command replay conflicts with existing command")
)

type PostgresStore struct{ DB *sql.DB }

type State = reconciliation.FenceState

func (s *PostgresStore) validate() error {
	if s == nil || s.DB == nil {
		return ErrNotConfigured
	}
	return nil
}

func canonicalCommand(c reconciliation.FenceCommand) ([]byte, error) {
	c.Signature = ""
	return json.Marshal(c)
}

func commandHash(c reconciliation.FenceCommand) (string, []byte, error) {
	payload, err := canonicalCommand(c)
	if err != nil {
		return "", nil, err
	}
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:]), payload, nil
}

// RecordFenceCommand is retained for the legacy FenceAudit interface. New
// callers should use RecordFenceCommandContext so cancellation reaches SQL.
func (s *PostgresStore) RecordFenceCommand(c reconciliation.FenceCommand, auditHash string) error {
	return s.RecordFenceCommandContext(context.Background(), c, auditHash)
}

// RecordFenceCommandContext atomically records a command and applies its
// environment state. The transaction uses a per-environment PostgreSQL
// advisory lock, the command primary key, and the command hash to make replay
// behavior deterministic across all payment-engine replicas.
func (s *PostgresStore) RecordFenceCommandContext(ctx context.Context, c reconciliation.FenceCommand, _ string) error {
	if err := s.validate(); err != nil {
		return err
	}
	if c.CommandID == "" || c.Environment == "" || c.Signer == "" {
		return errors.New("command identity is required")
	}
	if c.Action != reconciliation.FenceActionFence && c.Action != reconciliation.FenceActionOpen {
		return errors.New("unsupported fence action")
	}
	hash, _, err := commandHash(c)
	if err != nil {
		return err
	}
	alerts, err := json.Marshal(c.SourceAlerts)
	if err != nil {
		return err
	}

	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Serialize command application for one environment while permitting
	// independent environments to progress concurrently.
	if _, err := tx.ExecContext(ctx,
		`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, c.Environment,
	); err != nil {
		return fmt.Errorf("lock fence environment: %w", err)
	}

	var version uint64
	var inserted bool
	err = tx.QueryRowContext(ctx, `
        INSERT INTO settlement_fence_commands
          (command_id, command_hash, action, reason, environment, source_alerts,
           issued_at, expires_at, nonce, signer, audit_hash)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
        ON CONFLICT (command_id) DO NOTHING
        RETURNING fence_version`,
		c.CommandID, hash, c.Action, c.Reason, c.Environment, string(alerts),
		c.IssuedAt.UTC(), c.ExpiresAt.UTC(), c.Nonce, c.Signer, hash,
	).Scan(&version)
	if errors.Is(err, sql.ErrNoRows) {
		inserted = false
		var existingHash string
		var existingAction reconciliation.FenceAction
		var existingEnvironment string
		err = tx.QueryRowContext(ctx, `
            SELECT command_hash, action, environment
              FROM settlement_fence_commands
             WHERE command_id=$1
             FOR UPDATE`, c.CommandID).Scan(&existingHash, &existingAction, &existingEnvironment)
		if err != nil {
			return err
		}
		if existingHash != hash || existingAction != c.Action || existingEnvironment != c.Environment {
			return ErrReplayConflict
		}
	} else if err != nil {
		return fmt.Errorf("insert fence command: %w", err)
	} else {
		inserted = true
	}

	if inserted {
		_, err = tx.ExecContext(ctx, `
            INSERT INTO settlement_fence_state
              (environment, fenced, fence_version, reason, command_id, updated_at)
            VALUES ($1,$2,$3,$4,$5,now())
            ON CONFLICT (environment) DO UPDATE SET
              fenced=EXCLUDED.fenced,
              fence_version=EXCLUDED.fence_version,
              reason=EXCLUDED.reason,
              command_id=EXCLUDED.command_id,
              updated_at=EXCLUDED.updated_at`,
			c.Environment, c.Action == reconciliation.FenceActionFence,
			version, c.Reason, c.CommandID,
		)
		if err != nil {
			return fmt.Errorf("apply durable fence state: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit fence command/state: %w", err)
	}
	return nil
}

func (s *PostgresStore) CommandHash(c reconciliation.FenceCommand) (string, error) {
	if err := s.validate(); err != nil {
		return "", err
	}
	hash, _, err := commandHash(c)
	return hash, err
}

// LoadState returns the durable state observed by this replica. Missing state
// is deliberately interpreted as fenced, so an uninitialized environment
// cannot become writable accidentally.
// AcquireAdmission holds a row-level PostgreSQL lock on the environment fence
// state until the caller releases the returned token. This closes the race where
// a FENCE command could commit after a successful read but before TigerBeetle
// submission. The token must be released on every path.
func (s *PostgresStore) AcquireAdmission(ctx context.Context, environment string) (ledger.AdmissionToken, error) {
	if err := s.validate(); err != nil {
		return ledger.AdmissionToken{}, err
	}
	if environment == "" {
		return ledger.AdmissionToken{}, errors.New("environment is required")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return ledger.AdmissionToken{}, fmt.Errorf("begin fence admission: %w", err)
	}
	var fenced bool
	var version int64
	err = tx.QueryRowContext(ctx, `
		SELECT fenced, fence_version
		  FROM settlement_fence_state
		 WHERE environment=$1
		 FOR UPDATE`, environment).Scan(&fenced, &version)
	if errors.Is(err, sql.ErrNoRows) {
		_ = tx.Rollback()
		return ledger.AdmissionToken{}, errors.New("durable fence state is absent; settlement remains fenced")
	}
	if err != nil {
		_ = tx.Rollback()
		return ledger.AdmissionToken{}, fmt.Errorf("read fence admission state: %w", err)
	}
	if fenced || version <= 0 {
		_ = tx.Rollback()
		return ledger.AdmissionToken{}, errors.New("settlement is durably fenced")
	}
	var once sync.Once
	release := func() error {
		var releaseErr error
		once.Do(func() { releaseErr = tx.Commit() })
		return releaseErr
	}
	return ledger.AdmissionToken{Environment: environment, Version: uint64(version), Release: release}, nil
}

func (s *PostgresStore) LoadState(ctx context.Context, environment string) (State, error) {
	if err := s.validate(); err != nil {
		return State{}, err
	}
	if environment == "" {
		return State{}, errors.New("environment is required")
	}
	var state State
	var version int64
	err := s.DB.QueryRowContext(ctx, `
        SELECT environment, fenced, fence_version, reason, COALESCE(command_id, '')
          FROM settlement_fence_state
         WHERE environment=$1`, environment).
		Scan(&state.Environment, &state.Fenced, &version, &state.Reason, &state.CommandID)
	if errors.Is(err, sql.ErrNoRows) {
		return State{Environment: environment, Fenced: true, Reason: "durable fence state is absent"}, nil
	}
	if err != nil {
		return State{}, fmt.Errorf("load durable fence state: %w", err)
	}
	if version < 0 {
		return State{}, errors.New("durable fence version is negative")
	}
	state.Version = uint64(version)
	return state, nil
}

var _ reconciliation.FenceAudit = (*PostgresStore)(nil)
