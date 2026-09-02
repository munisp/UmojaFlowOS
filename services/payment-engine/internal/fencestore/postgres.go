package fencestore

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/reconciliation"
)

var (
	ErrNotConfigured  = errors.New("settlement fence command store is not configured")
	ErrReplayConflict = errors.New("settlement fence command replay conflicts with existing command")
)

type PostgresStore struct{ DB *sql.DB }

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

// RecordFenceCommand implements reconciliation.FenceAudit. It is safe across
// replicas because command_id is a PostgreSQL primary key and the conflict
// comparison occurs while the conflicting row is locked in the transaction.
func (s *PostgresStore) RecordFenceCommand(c reconciliation.FenceCommand, auditHash string) error {
	return s.RecordFenceCommandContext(context.Background(), c, auditHash)
}

func (s *PostgresStore) RecordFenceCommandContext(ctx context.Context, c reconciliation.FenceCommand, _ string) error {
	if err := s.validate(); err != nil {
		return err
	}
	if c.CommandID == "" || c.Environment == "" || c.Signer == "" {
		return errors.New("command identity is required")
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

	result, err := tx.ExecContext(ctx, `
		INSERT INTO settlement_fence_commands
		(command_id, command_hash, action, reason, environment, source_alerts,
		 issued_at, expires_at, nonce, signer, audit_hash)
		VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)
		ON CONFLICT (command_id) DO NOTHING`,
		c.CommandID, hash, c.Action, c.Reason, c.Environment, string(alerts),
		c.IssuedAt.UTC(), c.ExpiresAt.UTC(), c.Nonce, c.Signer, hash)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		var existingHash string
		err = tx.QueryRowContext(ctx, `
			SELECT command_hash FROM settlement_fence_commands
			WHERE command_id=$1 FOR UPDATE`, c.CommandID).Scan(&existingHash)
		if err != nil {
			return err
		}
		if existingHash != hash {
			return ErrReplayConflict
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit fence command: %w", err)
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

var _ reconciliation.FenceAudit = (*PostgresStore)(nil)
