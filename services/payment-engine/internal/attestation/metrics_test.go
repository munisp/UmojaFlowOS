package attestation

import (
	"bytes"
	"strings"
	"testing"
	"time"
)

func TestMetricsWritePrometheusExportsDashboardSeries(t *testing.T) {
	metrics := NewMetrics()
	metrics.QueuePending.Store(3)
	metrics.QueueRunning.Store(2)
	metrics.QueueUnknown.Store(1)
	metrics.AdmissionInUse.Store(2)
	metrics.AdmissionLimit.Store(4)
	metrics.ClaimsTotal.Store(10)
	metrics.LeaseExpiredTotal.Store(2)
	metrics.MVCCConflictsTotal.Store(7)
	metrics.ObserveCommitLatency(25 * time.Millisecond)
	var output bytes.Buffer
	metrics.WritePrometheus(&output)
	body := output.String()
	for _, expected := range []string{
		`umoja_fabric_queue_depth{state="pending"} 3`,
		`umoja_fabric_queue_depth{state="running"} 2`,
		`umoja_fabric_admission_in_use 2`,
		`umoja_fabric_admission_limit 4`,
		`umoja_fabric_queue_claims_total 10`,
		`umoja_fabric_mvcc_conflicts_total 7`,
		`# TYPE umoja_fabric_commit_latency_seconds histogram`,
		`umoja_fabric_commit_latency_seconds_count 1`,
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("metrics missing %q: %s", expected, body)
		}
	}
}
