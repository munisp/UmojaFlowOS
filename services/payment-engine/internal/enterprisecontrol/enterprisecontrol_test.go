package enterprisecontrol

import "testing"

func TestStablecoinTreasuryRequiresEvidenceAndNeverMovesValue(t *testing.T) {
	result := Evaluate(GovernanceInput{Module: "stablecoin_treasury", LegalEntityID: "entity-1", CounterpartyEvidenceAccepted: true, PolicyEvidenceAccepted: true, IndependentReviewAccepted: true, ReconciledReferencePresent: true, StablecoinAsset: "USDC", TravelRuleEvidenceAccepted: false, BeneficiaryEvidenceAccepted: false})
	if result.Outcome != "blocked" {
		t.Fatalf("expected block, got %s", result.Outcome)
	}
	if result.StablecoinTransferInitiated || result.SettlementInitiated || result.FundingInitiated {
		t.Fatal("enterprise governance must not initiate external value movement")
	}
}
