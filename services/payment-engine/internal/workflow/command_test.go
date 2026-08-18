package workflow

import (
	"github.com/munisp/UmojaFlowOS/services/payment-engine/internal/domain"
	"testing"
	"time"
)

func TestWorkflowDoesNotStartExternalExecutionWithoutVerifiedProvider(t *testing.T) {
	order, err := domain.NewOrder("order-1", "idempotency-key-0001", domain.SouthAfricaZAR, domain.Money{Currency: "ZAR", Amount: "100"}, domain.Money{Currency: "USDC", Amount: "5"}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	result, err := EvaluateStart(StartInput{WorkflowID: "payment-order-1", Order: order, Policy: domain.PolicyDecision{Outcome: "ALLOW", Version: "v1"}, ProviderVerified: false})
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != domain.Approved || result.ExternalExecutionStarted {
		t.Fatalf("unexpected result: %#v", result)
	}
}
