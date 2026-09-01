package attestation

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"strings"
	"sync/atomic"
	"time"
)

var commitLatencyBuckets = [...]float64{0.01, 0.05, 0.1, 0.25, 0.5, 1, 5}

// Metrics contains observed counters and gauges. Queue depth is refreshed from
// PostgreSQL so it can represent the durable cross-replica state.
type Metrics struct {
	Namespace              string
	Pod                    string
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
	ClaimDurationCount     atomic.Uint64
	ClaimDurationSumMillis atomic.Uint64
	OldestLeaseAgeSeconds  atomic.Int64
}

func NewMetrics() *Metrics { return &Metrics{} }

func (m *Metrics) SetResourceLabels(namespace, pod string) {
	if m == nil {
		return
	}
	m.Namespace, m.Pod = namespace, pod
}

func (m *Metrics) scope() string {
	clean := func(v string) string { return strings.ReplaceAll(strings.ReplaceAll(v, "\\", "\\\\"), "\"", "\\\"") }
	if m.Namespace == "" && m.Pod == "" {
		return ""
	}
	return fmt.Sprintf(`namespace="%s",pod="%s"`, clean(m.Namespace), clean(m.Pod))
}

func (m *Metrics) labels(extra string) string {
	scope := m.scope()
	if scope == "" {
		return extra
	}
	if extra == "" {
		return scope
	}
	return scope + "," + extra
}

func (m *Metrics) metric(name, extra string) string {
	labels := m.labels(extra)
	if labels == "" {
		return name
	}
	return name + "{" + labels + "}"
}

// StartQueueDepthRefresher keeps each replica's exported queue gauges aligned with PostgreSQL.
// The caller owns cancellation and must provide a positive interval.
func StartQueueDepthRefresher(ctx context.Context, db *sql.DB, metrics *Metrics, interval time.Duration) error {
	if ctx == nil {
		return fmt.Errorf("metrics refresher context is required")
	}
	if db == nil || metrics == nil {
		return fmt.Errorf("metrics refresher database and metrics are required")
	}
	if interval <= 0 {
		return fmt.Errorf("metrics refresher interval must be positive")
	}
	if err := metrics.RefreshQueueDepth(ctx, db); err != nil {
		return err
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_ = metrics.RefreshQueueDepth(ctx, db)
			}
		}
	}()
	return nil
}

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
	for i, upper := range commitLatencyBuckets {
		if d.Seconds() <= upper {
			m.CommitLatencyBuckets[i].Add(1)
		}
	}
}

func (m *Metrics) ObserveClaimDuration(d time.Duration) {
	if m == nil {
		return
	}
	m.ClaimDurationCount.Add(1)
	m.ClaimDurationSumMillis.Add(uint64(d.Milliseconds()))
}

func (m *Metrics) WritePrometheus(w io.Writer) {
	if m == nil {
		return
	}
	fmt.Fprintln(w, "# HELP umoja_fabric_queue_depth Durable Fabric attestation queue depth by state.\n# TYPE umoja_fabric_queue_depth gauge")
	for _, state := range []string{"pending", "running", "unknown", "complete"} {
		var value int64
		switch state {
		case "pending":
			value = m.QueuePending.Load()
		case "running":
			value = m.QueueRunning.Load()
		case "unknown":
			value = m.QueueUnknown.Load()
		case "complete":
			value = m.QueueComplete.Load()
		}
		fmt.Fprintf(w, "umoja_fabric_queue_depth{%s} %d\n", m.labels(fmt.Sprintf(`state="%s"`, state)), value)
	}
	fmt.Fprintf(w, "# TYPE umoja_fabric_admission_in_use gauge\n%s %d\n", m.metric("umoja_fabric_admission_in_use", ""), m.AdmissionInUse.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_admission_limit gauge\n%s %d\n", m.metric("umoja_fabric_admission_limit", ""), m.AdmissionLimit.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_queue_claims_total counter\n%s %d\n", m.metric("umoja_fabric_queue_claims_total", ""), m.ClaimsTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_queue_claim_errors_total counter\n%s %d\n", m.metric("umoja_fabric_queue_claim_errors_total", ""), m.ClaimErrorsTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_queue_lease_lost_total counter\n%s %d\n", m.metric("umoja_fabric_queue_lease_lost_total", ""), m.LeaseLostTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_queue_lease_expired_total counter\n%s %d\n", m.metric("umoja_fabric_queue_lease_expired_total", ""), m.LeaseExpiredTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_unknown_queue_depth gauge\n%s %d\n", m.metric("umoja_fabric_unknown_queue_depth", ""), m.QueueUnknown.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_reconciliation_attempts_total counter\n%s %d\n", m.metric("umoja_fabric_reconciliation_attempts_total", ""), m.ReconciliationTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_queue_completed_total counter\n%s %d\n", m.metric("umoja_fabric_queue_completed_total", ""), m.CompleteTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_reconciliation_decision_conflicts_total counter\n%s %d\n", m.metric("umoja_fabric_reconciliation_decision_conflicts_total", ""), m.DecisionConflictTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_mvcc_conflicts_total counter\n%s %d\n", m.metric("umoja_fabric_mvcc_conflicts_total", ""), m.MVCCConflictsTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_submissions_total counter\n%s %d\n", m.metric("umoja_fabric_submissions_total", ""), m.SubmissionsTotal.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_commit_timeout_total counter\n%s %d\n", m.metric("umoja_fabric_commit_timeout_total", ""), m.CommitTimeoutTotal.Load())
	fmt.Fprintln(w, "# TYPE umoja_fabric_commit_latency_seconds histogram")
	for i, upper := range commitLatencyBuckets {
		fmt.Fprintf(w, "umoja_fabric_commit_latency_seconds_bucket{%s} %d\n", m.labels(fmt.Sprintf(`le="%.2f"`, upper)), m.CommitLatencyBuckets[i].Load())
	}
	fmt.Fprintf(w, "umoja_fabric_commit_latency_seconds_bucket{%s} %d\n", m.labels(`le="+Inf"`), m.CommitLatencyCount.Load())
	fmt.Fprintf(w, "%s %.6f\n", m.metric("umoja_fabric_commit_latency_seconds_sum", ""), float64(m.CommitLatencySumMillis.Load())/1000)
	fmt.Fprintf(w, "%s %d\n", m.metric("umoja_fabric_commit_latency_seconds_count", ""), m.CommitLatencyCount.Load())
	fmt.Fprintln(w, "# TYPE umoja_fabric_queue_claim_duration_seconds summary")
	fmt.Fprintf(w, "%s %.6f\n", m.metric("umoja_fabric_queue_claim_duration_seconds_sum", ""), float64(m.ClaimDurationSumMillis.Load())/1000)
	fmt.Fprintf(w, "%s %d\n", m.metric("umoja_fabric_queue_claim_duration_seconds_count", ""), m.ClaimDurationCount.Load())
	fmt.Fprintf(w, "# TYPE umoja_fabric_queue_oldest_lease_age_seconds gauge\n%s %d\n", m.metric("umoja_fabric_queue_oldest_lease_age_seconds", ""), m.OldestLeaseAgeSeconds.Load())
}
