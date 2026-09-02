package observability

import (
	"bytes"
	"strings"
	"testing"
)

func TestOPAReasonAndFailureCountersAreAllowlisted(t *testing.T) {
	metrics := NewReconciliationMetrics()
	metrics.ObserveOPADenial(OPADenialInvalidAsset)
	metrics.ObserveOPADenial("tenant-secret-policy-text")
	metrics.ObserveOPAEvaluationFailure(OPAFailureUpstream5xx)
	metrics.ObserveOPAEvaluationFailure("unbounded failure text")
	metrics.ObserveOPAEvaluationTimeout()
	metrics.ObserveOPARetryAttempt()
	metrics.ObserveOPARetryExhaustion()

	var output bytes.Buffer
	metrics.WritePrometheus(&output, "staging")
	text := output.String()

	checks := []string{
		`umoja_opa_policy_denials_total{environment="staging",reason="invalid_asset"} 1`,
		`umoja_opa_policy_denials_total{environment="staging",reason="other"} 1`,
		`umoja_opa_policy_evaluation_failures_total{environment="staging",failure_class="upstream_5xx"} 1`,
		`umoja_opa_policy_evaluation_failures_total{environment="staging",failure_class="transport_or_contract"} 1`,
		`umoja_opa_policy_evaluation_timeouts_total{environment="staging"} 1`,
		`umoja_opa_policy_retry_attempts_total{environment="staging"} 1`,
		`umoja_opa_policy_retry_exhaustions_total{environment="staging"} 1`,
	}
	for _, check := range checks {
		if !strings.Contains(text, check) {
			t.Errorf("metrics output missing %q", check)
		}
	}
	if strings.Contains(text, "tenant-secret-policy-text") || strings.Contains(text, "unbounded failure text") {
		t.Fatal("unbounded OPA values must never appear as Prometheus labels")
	}
}
