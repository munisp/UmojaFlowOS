package attestation

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

var ErrQueueLeaseLost = errors.New("Fabric attestation queue lease lost")

// QueueItem is a durable, idempotent Fabric attestation job. Payload is retained
// only when the caller explicitly authorizes it; evidence bytes should normally
// remain in the external evidence store and be represented by PayloadDigest.
type QueueItem struct {
	ID               string
	IdempotencyKey   string
	ReleaseSHA       string
	EvidenceID       string
	EvidenceURI      string
	PayloadDigest    string
	EndorsementScope string
	State            string
	Attempts         int
	LeaseToken       string
	LeaseUntil       time.Time
	NextAttemptAt    time.Time
	LastError        string
}

// PostgreSQLQueue provides durable single-flight execution across replicas.
type PostgreSQLQueue struct {
	DB            *sql.DB
	LeaseDuration time.Duration
	Metrics       *Metrics
}

func (q *PostgreSQLQueue) validate() error {
	if q == nil || q.DB == nil {
		return errors.New("Fabric queue database is required")
	}
	return nil
}

func (q *PostgreSQLQueue) Enqueue(ctx context.Context, item QueueItem) (bool, error) {
	if err := q.validate(); err != nil {
		return false, err
	}
	if item.IdempotencyKey == "" || item.ReleaseSHA == "" || item.EvidenceID == "" || item.PayloadDigest == "" {
		return false, errors.New("queue idempotency key, release SHA, evidence ID, and payload digest are required")
	}
	result, err := q.DB.ExecContext(ctx, `
		INSERT INTO fabric_attestation_queue
		(idempotency_key, release_sha, evidence_id, evidence_uri, payload_digest, endorsement_scope,
		 state, attempts, next_attempt_at)
		VALUES ($1,$2,$3,$4,$5,$6,'pending',0,now())
		ON CONFLICT (idempotency_key) DO NOTHING`,
		item.IdempotencyKey, item.ReleaseSHA, item.EvidenceID, item.EvidenceURI, item.PayloadDigest, item.EndorsementScope)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	if err == nil && n == 1 && q.Metrics != nil {
		q.Metrics.QueuePending.Add(1)
	}
	return n == 1, err
}

func (q *PostgreSQLQueue) Claim(ctx context.Context, now time.Time) (QueueItem, error) {
	if err := q.validate(); err != nil {
		return QueueItem{}, err
	}
	leaseDuration := q.LeaseDuration
	if leaseDuration <= 0 {
		leaseDuration = 30 * time.Second
	}
	tx, err := q.DB.BeginTx(ctx, nil)
	if err != nil {
		return QueueItem{}, err
	}
	defer tx.Rollback()
	var item QueueItem
	var leaseUntil time.Time
	err = tx.QueryRowContext(ctx, `
		SELECT id::text, idempotency_key, release_sha, evidence_id, evidence_uri, payload_digest,
		       endorsement_scope, state, attempts, next_attempt_at, COALESCE(last_error,'' )
		  FROM fabric_attestation_queue
		 WHERE (state IN ('pending','unknown') AND next_attempt_at <= $1)
		    OR (state = 'running' AND lease_until < $1)
		 ORDER BY next_attempt_at, created_at
		 FOR UPDATE SKIP LOCKED
		 LIMIT 1`, now.UTC()).Scan(
		&item.ID, &item.IdempotencyKey, &item.ReleaseSHA, &item.EvidenceID, &item.EvidenceURI,
		&item.PayloadDigest, &item.EndorsementScope, &item.State, &item.Attempts, &item.NextAttemptAt, &item.LastError)
	if errors.Is(err, sql.ErrNoRows) {
		return QueueItem{}, sql.ErrNoRows
	}
	if err != nil {
		return QueueItem{}, err
	}
	item.Attempts++
	item.LeaseToken = newLeaseToken()
	leaseUntil = now.UTC().Add(leaseDuration)
	if _, err = tx.ExecContext(ctx, `
		UPDATE fabric_attestation_queue
		   SET state='running', attempts=$2, lease_token=$3::uuid, lease_until=$4, updated_at=now()
		 WHERE id=$1`, item.ID, item.Attempts, item.LeaseToken, leaseUntil); err != nil {
		return QueueItem{}, err
	}
	if err = tx.Commit(); err != nil {
		return QueueItem{}, err
	}
	previousState := item.State
	item.State = "running"
	item.LeaseUntil = leaseUntil
	if q.Metrics != nil {
		q.Metrics.ClaimsTotal.Add(1)
		q.Metrics.QueueRunning.Add(1)
		if previousState == "unknown" {
			q.Metrics.QueueUnknown.Add(-1)
		} else {
			q.Metrics.QueuePending.Add(-1)
		}
	}
	return item, nil
}

func (q *PostgreSQLQueue) MarkUnknown(ctx context.Context, item QueueItem, next time.Time, reason string) error {
	if err := q.validate(); err != nil {
		return err
	}
	result, err := q.DB.ExecContext(ctx, `
		UPDATE fabric_attestation_queue
		   SET state='unknown', next_attempt_at=$4, last_error=$5, lease_token=NULL, lease_until=NULL, updated_at=now()
		 WHERE id=$1 AND state='running' AND attempts=$2 AND lease_token=$3::uuid`, item.ID, item.Attempts, item.LeaseToken, next.UTC(), reason)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		if q.Metrics != nil {
			q.Metrics.LeaseLostTotal.Add(1)
		}
		return ErrQueueLeaseLost
	}
	if q.Metrics != nil {
		q.Metrics.QueueRunning.Add(-1)
		q.Metrics.QueueUnknown.Add(1)
	}
	return nil
}

func (q *PostgreSQLQueue) MarkComplete(ctx context.Context, item QueueItem, attestationID string) error {
	if err := q.validate(); err != nil {
		return err
	}
	if attestationID == "" {
		return errors.New("attestation ID is required")
	}
	result, err := q.DB.ExecContext(ctx, `
		UPDATE fabric_attestation_queue
		   SET state='complete', attestation_id=$4, lease_token=NULL, lease_until=NULL, completed_at=now(), updated_at=now()
		 WHERE id=$1 AND state='running' AND attempts=$2 AND lease_token=$3::uuid`, item.ID, item.Attempts, item.LeaseToken, attestationID)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		if q.Metrics != nil {
			q.Metrics.LeaseLostTotal.Add(1)
		}
		return ErrQueueLeaseLost
	}
	if q.Metrics != nil {
		q.Metrics.QueueRunning.Add(-1)
		q.Metrics.QueueComplete.Add(1)
		q.Metrics.CompleteTotal.Add(1)
	}
	return nil
}

func newLeaseToken() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return hex.EncodeToString(b[:])
	}
	return fmt.Sprintf("%s-%s-%s-%s-%s", hex.EncodeToString(b[0:4]), hex.EncodeToString(b[4:6]), hex.EncodeToString(b[6:8]), hex.EncodeToString(b[8:10]), hex.EncodeToString(b[10:16]))
}

// AdmissionController bounds concurrent calls to Fabric across one process.
type AdmissionController struct {
	sem     chan struct{}
	metrics *Metrics
}

func NewAdmissionController(limit int) (*AdmissionController, error) {
	if limit <= 0 {
		return nil, errors.New("Fabric admission limit must be positive")
	}
	return &AdmissionController{sem: make(chan struct{}, limit)}, nil
}

func (a *AdmissionController) SetMetrics(metrics *Metrics) {
	a.metrics = metrics
	if metrics != nil && a.sem != nil {
		metrics.AdmissionLimit.Store(int64(cap(a.sem)))
	}
}

func (a *AdmissionController) Acquire(ctx context.Context) error {
	if a == nil || a.sem == nil {
		return errors.New("Fabric admission controller is not configured")
	}
	select {
	case a.sem <- struct{}{}:
		if a.metrics != nil {
			a.metrics.AdmissionInUse.Add(1)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *AdmissionController) Release() {
	if a == nil || a.sem == nil {
		return
	}
	select {
	case <-a.sem:
		if a.metrics != nil {
			a.metrics.AdmissionInUse.Add(-1)
		}
	default:
	}
}
