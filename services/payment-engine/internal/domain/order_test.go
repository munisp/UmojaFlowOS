package domain

import (
	"testing"
	"time"
)

func TestOrderFailsClosedUntilPolicyAndProviderEvidenceExist(t *testing.T) {
	order, err := NewOrder("ord_01", "idem_01", NigeriaNGN, Money{Currency: "NGN", Amount: "100.00"}, Money{Currency: "USDC", Amount: "0.05"}, time.Date(2026, 8, 17, 0, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("NewOrder() error = %v", err)
	}
	if err := order.StartExecution(true); err == nil {
		t.Fatal("execution succeeded before policy decision")
	}
	if err := order.ApplyPolicy(PolicyDecision{Outcome: "ALLOW", Version: "2026.08.17"}); err != nil {
		t.Fatalf("ApplyPolicy() error = %v", err)
	}
	if err := order.StartExecution(false); err == nil {
		t.Fatal("execution succeeded without verified provider evidence")
	}
	if err := order.StartExecution(true); err != nil {
		t.Fatalf("StartExecution() error = %v", err)
	}
	if err := order.Complete(""); err == nil {
		t.Fatal("completion succeeded without provider finality")
	}
}
