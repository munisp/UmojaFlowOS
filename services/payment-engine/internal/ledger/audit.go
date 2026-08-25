package ledger

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type LedgerAuditEvent struct {
	AuditSchema     string    `json:"audit_schema"`
	Event           string    `json:"event"`
	OccurredAt      time.Time `json:"occurred_at"`
	TransferID      uint64    `json:"transfer_id"`
	CorrelationID   string    `json:"correlation_id"`
	Currency        string    `json:"currency"`
	AmountMinor     uint64    `json:"amount_minor"`
	DebitAccountID  uint64    `json:"debit_account_id"`
	CreditAccountID uint64    `json:"credit_account_id"`
	Result          string    `json:"result"`
}

type AuditLogger interface {
	WriteLedgerEvent(LedgerAuditEvent) error
}

type JSONLAuditLogger struct {
	path string
	mu   sync.Mutex
}

func NewJSONLAuditLogger(path string) (*JSONLAuditLogger, error) {
	if path == "" || filepath.IsAbs(path) == false {
		return nil, errors.New("ledger audit path must be absolute")
	}
	return &JSONLAuditLogger{path: path}, nil
}

func (l *JSONLAuditLogger) WriteLedgerEvent(event LedgerAuditEvent) error {
	if l == nil || l.path == "" {
		return errors.New("ledger audit logger is not configured")
	}
	event.AuditSchema = "umoja.security.audit.v1"
	if event.OccurredAt.IsZero() {
		event.OccurredAt = time.Now().UTC()
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(l.path), 0750); err != nil {
		return fmt.Errorf("create ledger audit directory: %w", err)
	}
	file, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0640)
	if err != nil {
		return fmt.Errorf("open ledger audit log: %w", err)
	}
	defer file.Close()
	if err := json.NewEncoder(file).Encode(event); err != nil {
		return fmt.Errorf("write ledger audit event: %w", err)
	}
	return file.Sync()
}
