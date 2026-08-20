package tradecontrol

import "testing"

func TestStablecoinTradeCaseFailsClosedWhenTravelRuleEvidenceMissing(t *testing.T) {
	result := Evaluate(RehearsalInput{CaseID: "TPC-NG-001", Corridor: "NIGERIA_NGN", PurchaseCurrency: "USDC", DocumentaryEvidenceAccepted: true, AuthorisedRouteApproved: true, IndependentApprovals: []string{"corporate_trade_sponsor", "procurement_owner", "trade_finance_operator", "compliance_officer", "treasury_operator"}})
	if result.Outcome != "blocked" || result.ExternalExecutionInitiated || result.ProviderInstructionCreated || result.SettlementCreated {
		t.Fatalf("expected a non-executable blocked result, got %#v", result)
	}
}
