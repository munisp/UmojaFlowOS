package attestation

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"sync/atomic"
	"time"
)

var commitLatencyBuckets = [...]float64{0.01, 0.05, 0.1, 0.25, 0.5, 1, 5}

// Metrics contains only observed counters and gauges. Queue state gauges are
// refreshed from PostgreSQL so they are not fabricated from one replica's view.
type Metrics struct {
	QueuePending           atomic.Int64
	QueueRunning           atomic.Int64
	QueueUnknown           atomic.Int64
	QueueComplete          atomic.Int64
	AdmissionInUse         atomic.Int64
	AdmissionLimit         atomic.Int64
	ClaimsTotal            atomic.Uint64
	ClaimErrorsTotal       atomic.Uint64
	LeaseLostTotal         atomic.Uint64
	LeaseExpiredTotal      atomic.Uint64
	ReconciliationTotal    atomic.Uint64
	CompleteTotal          atomic.Uint64
	DecisionConflictTotal  atomic.Uint64
	MVCCConflictsTotal     atomic.Uint64
	SubmissionsTotal       atomic.Uint64
	CommitTimeoutTotal     atomic.Uint64
	CommitLatencyCount     atomic.Uint64
	CommitLatencySumMillis atomic.Uint64
	CommitLatencyBuckets   [len(commitLatencyBuckets)]atomic.Uint64
	OldestLeaseAgeSeconds  atomic.Int64
}

func NewMetrics() *Metrics { return &Metrics{} }

func (m *Metrics) RefreshQueueDepth(ctx context.Context, db *sql.DB) error {
	if m == nil || db == nil {
		return fmt.Errorf("metrics database is required")
	}
	rows, err := db.QueryContext(ctx, `SELECT state, count(*) FROM fabric_attestation_queue GROUP BY state`)
	if err != nil {
		return err
	}
	defer rows.Close()
	var pending, running, unknown, complete int64
	for rows.Next() {
		var state string
		var count int64
		if err := rows.Scan(&state, &count); err != nil {
			return err
		}
		switch state {
		case "pending":
			pending = count
		case "running":
			running = count
		case "unknown":
			unknown = count
		case "complete":
			complete = count
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	m.QueuePending.Store(pending)
	m.QueueRunning.Store(running)
	m.QueueUnknown.Store(unknown)
	m.QueueComplete.Store(complete)
	return nil
}

func (m *Metrics) ObserveCommitLatency(d time.Duration) {
	if m == nil {
		return
	}
	m.SubmissionsTotal.Add(1)
	m.CommitLatencyCount.Add(1)
	m.CommitLatencySumMillis.Add(uint64(d.Milliseconds()))
	seconds := d.Seconds()
	for i, upper := range commitLatencyBuckets {
		if seconds <= upper {
			m.CommitLatencyBuckets[i].Add(1)
		}
	}
}

func (m *Metrics) WritePrometheus(w io.Writer) {
	if m == nil {
		return
	}
	fmt.Fprintln(w, "# HELP umoja_fabric_queue_depth Durable Fabric attestation queue depth by state.\n# TYPE umoja_fabric_queue_depth gauge")
	fmt.Fprintf(w, "umoja_fabric_queue_depth{state=\"pending\"} %d\n", m.QueuePending.Load())
	fmt.Fprintf(w, "umoja_fabric_queue_depth{state=\"running\"} %d\n", m.QueueRunning.Load())
	fmt.Fprintf(w, "umoja_fabric_queue_depth{state=\"unknown\"} %d\n", m.QueueUnknown.Load())
	fmt.Fprintf(w, "umoja_fabric_queue_depth{state=\"complete\"} %d\n", m.QueueComplete.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_admission_in_use gauge\numoja_fabric_admission_in_use %d\n", m.AdmissionInUse.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_admission_limit gauge\numoja_fabric_admission_limit %d\n", m.AdmissionLimit.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_queue_claims_total counter\numoja_fabric_queue_claims_total %d\n", m.ClaimsTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_queue_claim_errors_total counter\numoja_fabric_queue_claim_errors_total %d\n", m.ClaimErrorsTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_queue_lease_lost_total counter\numoja_fabric_queue_lease_lost_total %d\n", m.LeaseLostTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_queue_lease_expired_total counter\numoja_fabric_queue_lease_expired_total %d\n", m.LeaseExpiredTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_unknown_queue_depth gauge\numoja_fabric_unknown_queue_depth %d\n", m.QueueUnknown.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_reconciliation_attempts_total counter\numoja_fabric_reconciliation_attempts_total %d\n", m.ReconciliationTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_queue_completed_total counter\numoja_fabric_queue_completed_total %d\n", m.CompleteTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_reconciliation_decision_conflicts_total counter\numoja_fabric_reconciliation_decision_conflicts_total %d\n", m.DecisionConflictTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_mvcc_conflicts_total counter\numoja_fabric_mvcc_conflicts_total %d\n", m.MVCCConflictsTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_submissions_total counter\numoja_fabric_submissions_total %d\n", m.SubmissionsTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_commit_timeout_total counter\numoja_fabric_commit_timeout_total %d\n", m.CommitTimeoutTotal.Load())
	fmt.Fprintln(w, "# TYPE umoja_fabric_commit_latency_seconds histogram")
	for i, upper := range commitLatencyBuckets {
		fmt.Fprintf(w, "umoja_fabric_commit_latency_seconds_bucket{le=\"%.2f\"} %d\n", upper, m.CommitLatencyBuckets[i].Load())
	}
	fmt.Fprintf(w, "umoja_fabric_commit_latency_seconds_bucket{le=\"+Inf\"} %d\n", m.CommitLatencyCount.Load())
	fmt.Fprintf(w, "umoja_fabric_commit_latency_seconds_sum %.6f\n", float64(m.CommitLatencySumMillis.Load())/1000)
	fmt.Fprintf(w, "umoja_fabric_commit_latency_seconds_count %d\n", m.CommitLatencyCount.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_queue_oldest_lease_age_seconds gauge\numoja_fabric_queue_oldest_lease_age_seconds %d\n", m.OldestLeaseAgeSeconds.Load())
}
