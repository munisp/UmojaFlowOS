package multirail

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"time"
)

var (
	ErrRecoveryEvidenceNotSafe = errors.New("post-recovery evidence is not safe for UNKNOWN reconciliation")
	ErrRecoveryRunBinding      = errors.New("post-recovery reconciliation run binding mismatch")
)

var recoveryRunIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`)

// RecoveryEvidence is an independent read-only snapshot. It must be collected
// after the ledger and database recovery procedures, not inferred from the
// payment request being reconciled.
type RecoveryEvidence struct {
	ReleaseSHA                 string
	ReconciliationRunID        string
	TigerBeetleQuorumHealthy   bool
	TigerBeetleViewsConverged  bool
	PostgresPrimaryTrusted     bool
	PostgresProjectionMismatch int
	KafkaLagRecords            int64
	KafkaLagLimit              int64
	SettlementFenceActive      bool
	CapturedAt                 time.Time
}

func (e RecoveryEvidence) Validate(expectedReleaseSHA, expectedRunID string, now time.Time) error {
	if !recoveryRunIDPattern.MatchString(expectedRunID) || e.ReconciliationRunID != expectedRunID {
		return fmt.Errorf("%w: expected=%q observed=%q", ErrRecoveryRunBinding, expectedRunID, e.ReconciliationRunID)
	}
	if e.ReleaseSHA != expectedReleaseSHA || !regexp.MustCompile(`^[a-f0-9]{40}$`).MatchString(e.ReleaseSHA) {
		return fmt.Errorf("%w: release SHA mismatch", ErrRecoveryEvidenceNotSafe)
	}
	if !e.TigerBeetleQuorumHealthy || !e.TigerBeetleViewsConverged || !e.PostgresPrimaryTrusted {
		return fmt.Errorf("%w: ledger/database trust conditions are not met", ErrRecoveryEvidenceNotSafe)
	}
	if e.PostgresProjectionMismatch != 0 {
		return fmt.Errorf("%w: PostgreSQL projection mismatches=%d", ErrRecoveryEvidenceNotSafe, e.PostgresProjectionMismatch)
	}
	if e.KafkaLagLimit < 0 || e.KafkaLagRecords < 0 || e.KafkaLagRecords > e.KafkaLagLimit {
		return fmt.Errorf("%w: Kafka lag is outside the recovery limit", ErrRecoveryEvidenceNotSafe)
	}
	if !e.SettlementFenceActive {
		return fmt.Errorf("%w: settlement fence must remain active during UNKNOWN recovery", ErrRecoveryEvidenceNotSafe)
	}
	if e.CapturedAt.IsZero() || e.CapturedAt.After(now.UTC().Add(time.Minute)) {
		return fmt.Errorf("%w: evidence timestamp is invalid", ErrRecoveryEvidenceNotSafe)
	}
	return nil
}

// PostRecoveryReconciler performs a read-only provider query through the
// existing ReconciliationWorker. It never submits a payment or authorizes
// settlement. Confirmed provider outcomes remain non-authoritative.
type PostRecoveryReconciler struct {
	Worker             ReconciliationWorker
	Evidence           RecoveryEvidence
	ExpectedReleaseSHA string
	ExpectedRunID      string
	Now                func() time.Time
}

func (r PostRecoveryReconciler) Reconcile(ctx context.Context, key string, provider Rail) (ReconciliationResult, error) {
	now := time.Now
	if r.Now != nil {
		now = r.Now
	}
	if err := r.Evidence.Validate(r.ExpectedReleaseSHA, r.ExpectedRunID, now()); err != nil {
		return ReconciliationResult{}, err
	}
	if r.Worker.Store == nil {
		return ReconciliationResult{}, errors.New("reconciliation store is required")
	}
	return r.Worker.Reconcile(ctx, key, provider)
}
