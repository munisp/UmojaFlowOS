package observability

import (
	"fmt"
	"io"
	"strings"
	"sync/atomic"
)

// OPA denial reasons are intentionally fixed. Never use provider, tenant,
// intent, run ID, or arbitrary policy text as a Prometheus label.
const (
	OPADenialInvalidRelease  = "invalid_release"
	OPADenialInvalidRunID    = "invalid_run_id"
	OPADenialInvalidAmount   = "invalid_amount"
	OPADenialInvalidAsset    = "invalid_asset"
	OPADenialInvalidIdentity = "invalid_identity"
	OPADenialInvalidFinality = "invalid_finality"
	OPADenialOther           = "other"
)

var opaDenialReasons = [...]string{
	OPADenialInvalidRelease,
	OPADenialInvalidRunID,
	OPADenialInvalidAmount,
	OPADenialInvalidAsset,
	OPADenialInvalidIdentity,
	OPADenialInvalidFinality,
	OPADenialOther,
}

// OPA failure classes are intentionally fixed and bounded.
const (
	OPAFailureTimeout             = "timeout"
	OPAFailureNetworkTimeout      = "network_timeout"
	OPAFailureUpstream5xx         = "upstream_5xx"
	OPAFailureMalformedResponse   = "malformed_response"
	OPAFailureTransportOrContract = "transport_or_contract"
)

var opaFailureClasses = [...]string{
	OPAFailureTimeout,
	OPAFailureNetworkTimeout,
	OPAFailureUpstream5xx,
	OPAFailureMalformedResponse,
	OPAFailureTransportOrContract,
}

// ReconciliationMetrics is process-local telemetry state. It contains only
// bounded labels and numeric values; reconciliation run IDs belong in OTel
// spans/logs, not Prometheus labels.
type ReconciliationMetrics struct {
	tigerBeetleLagMillis        atomic.Int64
	tigerBeetleQuorumHealthy    atomic.Int64
	tigerBeetleViewsConverged   atomic.Int64
	postgresProjectionMismatch  atomic.Int64
	postgresReplicationLagBytes atomic.Int64
	kafkaConsumerLagRecords     atomic.Int64

	opaDenialsTotal          atomic.Uint64
	opaDenialsByReason       [len(opaDenialReasons)]atomic.Uint64
	opaEvaluationErrorsTotal atomic.Uint64
	opaEvaluationTimeouts    atomic.Uint64
	opaFailuresByClass       [len(opaFailureClasses)]atomic.Uint64
	opaRetryAttempts         atomic.Uint64
	opaRetryExhaustions      atomic.Uint64
	unknownIntentsTotal      atomic.Uint64
	settlementFenceActive    atomic.Int64
}

func NewReconciliationMetrics() *ReconciliationMetrics {
	m := &ReconciliationMetrics{}
	m.tigerBeetleQuorumHealthy.Store(-1)
	m.tigerBeetleViewsConverged.Store(-1)
	m.settlementFenceActive.Store(1)
	return m
}

func (m *ReconciliationMetrics) SetTigerBeetleHealth(lagMillis int64, quorumHealthy, viewsConverged bool) {
	m.tigerBeetleLagMillis.Store(lagMillis)
	m.tigerBeetleQuorumHealthy.Store(boolInt(quorumHealthy))
	m.tigerBeetleViewsConverged.Store(boolInt(viewsConverged))
}

func (m *ReconciliationMetrics) SetPostgresHealth(replicationLagBytes, projectionMismatches int64) {
	m.postgresReplicationLagBytes.Store(replicationLagBytes)
	m.postgresProjectionMismatch.Store(projectionMismatches)
}

func (m *ReconciliationMetrics) SetKafkaConsumerLag(records int64) {
	m.kafkaConsumerLagRecords.Store(records)
}

func (m *ReconciliationMetrics) ObserveOPADenial(reason string) {
	m.opaDenialsTotal.Add(1)
	m.opaDenialsByReason[opaDenialReasonIndex(reason)].Add(1)
}

// ObserveOPAEvaluationError preserves the original aggregate counter API and
// records an optionally classified failure when a class is supplied.
func (m *ReconciliationMetrics) ObserveOPAEvaluationError() {
	m.opaEvaluationErrorsTotal.Add(1)
}

func (m *ReconciliationMetrics) ObserveOPAEvaluationFailure(failureClass string) {
	m.opaEvaluationErrorsTotal.Add(1)
	m.opaFailuresByClass[opaFailureClassIndex(failureClass)].Add(1)
}

func (m *ReconciliationMetrics) ObserveOPAEvaluationTimeout() {
	m.opaEvaluationTimeouts.Add(1)
	m.opaFailuresByClass[opaFailureClassIndex(OPAFailureTimeout)].Add(1)
	m.opaEvaluationErrorsTotal.Add(1)
}

func (m *ReconciliationMetrics) ObserveOPARetryAttempt() {
	m.opaRetryAttempts.Add(1)
}

func (m *ReconciliationMetrics) ObserveOPARetryExhaustion() {
	m.opaRetryExhaustions.Add(1)
}

func (m *ReconciliationMetrics) ObserveUnknownIntent() {
	m.unknownIntentsTotal.Add(1)
}

func (m *ReconciliationMetrics) SetSettlementFence(active bool) {
	m.settlementFenceActive.Store(boolInt(active))
}

func (m *ReconciliationMetrics) WritePrometheus(w io.Writer, environment string) {
	if environment == "" {
		environment = "unknown"
	}
	baseLabels := fmt.Sprintf("{environment=%q}", environment)

	fmt.Fprintf(w, "# HELP umoja_tigerbeetle_replication_lag_seconds Current trusted TigerBeetle replication lag.\n# TYPE umoja_tigerbeetle_replication_lag_seconds gauge\numoja_tigerbeetle_replication_lag_seconds%s %.3f\n", baseLabels, float64(m.tigerBeetleLagMillis.Load())/1000)
	fmt.Fprintf(w, "# HELP umoja_tigerbeetle_cluster_quorum_healthy Whether the TigerBeetle quorum is trusted.\n# TYPE umoja_tigerbeetle_cluster_quorum_healthy gauge\numoja_tigerbeetle_cluster_quorum_healthy%s %d\n", baseLabels, m.tigerBeetleQuorumHealthy.Load())
	fmt.Fprintf(w, "# HELP umoja_tigerbeetle_cluster_recovery_view_converged Whether TigerBeetle views have converged.\n# TYPE umoja_tigerbeetle_cluster_recovery_view_converged gauge\numoja_tigerbeetle_cluster_recovery_view_converged%s %d\n", baseLabels, m.tigerBeetleViewsConverged.Load())
	fmt.Fprintf(w, "# HELP umoja_postgres_replication_lag_bytes PostgreSQL replication lag in bytes.\n# TYPE umoja_postgres_replication_lag_bytes gauge\numoja_postgres_replication_lag_bytes%s %d\n", baseLabels, m.postgresReplicationLagBytes.Load())
	fmt.Fprintf(w, "# HELP umoja_ledger_reconciliation_mismatches_total Current unexplained PostgreSQL/TigerBeetle projection mismatches.\n# TYPE umoja_ledger_reconciliation_mismatches_total gauge\numoja_ledger_reconciliation_mismatches_total%s %d\n", baseLabels, m.postgresProjectionMismatch.Load())
	fmt.Fprintf(w, "# HELP umoja_kafka_consumer_lag_records Current reconciliation consumer lag.\n# TYPE umoja_kafka_consumer_lag_records gauge\numoja_kafka_consumer_lag_records%s %d\n", baseLabels, m.kafkaConsumerLagRecords.Load())

	fmt.Fprintf(w, "# HELP umoja_opa_policy_denials_total Total OPA policy denials.\n# TYPE umoja_opa_policy_denials_total counter\numoja_opa_policy_denials_total%s %d\n", baseLabels, m.opaDenialsTotal.Load())
	for i, reason := range opaDenialReasons {
		fmt.Fprintf(w, "umoja_opa_policy_denials_total{environment=%q,reason=%q} %d\n", environment, reason, m.opaDenialsByReason[i].Load())
	}

	fmt.Fprintf(w, "# HELP umoja_opa_policy_evaluation_errors_total Total OPA evaluation errors.\n# TYPE umoja_opa_policy_evaluation_errors_total counter\numoja_opa_policy_evaluation_errors_total%s %d\n", baseLabels, m.opaEvaluationErrorsTotal.Load())
	fmt.Fprintf(w, "# HELP umoja_opa_policy_evaluation_timeouts_total Total OPA evaluation timeouts.\n# TYPE umoja_opa_policy_evaluation_timeouts_total counter\numoja_opa_policy_evaluation_timeouts_total%s %d\n", baseLabels, m.opaEvaluationTimeouts.Load())
	fmt.Fprintf(w, "# HELP umoja_opa_policy_retry_attempts_total Total bounded OPA retry attempts.\n# TYPE umoja_opa_policy_retry_attempts_total counter\numoja_opa_policy_retry_attempts_total%s %d\n", baseLabels, m.opaRetryAttempts.Load())
	fmt.Fprintf(w, "# HELP umoja_opa_policy_retry_exhaustions_total Total exhausted OPA retry budgets.\n# TYPE umoja_opa_policy_retry_exhaustions_total counter\numoja_opa_policy_retry_exhaustions_total%s %d\n", baseLabels, m.opaRetryExhaustions.Load())
	fmt.Fprintf(w, "# HELP umoja_opa_policy_evaluation_failures_total OPA evaluation failures by bounded class.\n# TYPE umoja_opa_policy_evaluation_failures_total counter\n")
	for i, failureClass := range opaFailureClasses {
		fmt.Fprintf(w, "umoja_opa_policy_evaluation_failures_total{environment=%q,failure_class=%q} %d\n", environment, failureClass, m.opaFailuresByClass[i].Load())
	}

	fmt.Fprintf(w, "# HELP umoja_payment_unknown_state_total Total UNKNOWN intents observed.\n# TYPE umoja_payment_unknown_state_total counter\numoja_payment_unknown_state_total%s %d\n", baseLabels, m.unknownIntentsTotal.Load())
	fmt.Fprintf(w, "# HELP umoja_tigerbeetle_settlement_fence_active Whether settlement writes are fenced.\n# TYPE umoja_tigerbeetle_settlement_fence_active gauge\numoja_tigerbeetle_settlement_fence_active%s %d\n", baseLabels, m.settlementFenceActive.Load())
}

func opaDenialReasonIndex(value string) int {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case OPADenialInvalidRelease:
		return 0
	case OPADenialInvalidRunID:
		return 1
	case OPADenialInvalidAmount:
		return 2
	case OPADenialInvalidAsset:
		return 3
	case OPADenialInvalidIdentity:
		return 4
	case OPADenialInvalidFinality:
		return 5
	default:
		return 6
	}
}

func opaFailureClassIndex(value string) int {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case OPAFailureTimeout:
		return 0
	case OPAFailureNetworkTimeout:
		return 1
	case OPAFailureUpstream5xx:
		return 2
	case OPAFailureMalformedResponse:
		return 3
	default:
		return 4
	}
}

func boolInt(value bool) int64 {
	if value {
		return 1
	}
	return 0
}
