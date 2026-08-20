package vaspcontrol

import "testing"

func TestEvaluateVaspReadinessRefusesExternalAuthority(t *testing.T) {
	result := Evaluate(ReadinessInput{SupervisoryPathEvidencePresent: true, CorporateEvidencePresent: true, PrincipalOfficerEvidencePresent: true, NFIUEvidencePresent: true, AMLProgrammePresent: true, CyberControlsPresent: true, IncidentPlanPresent: true, TravelRuleDataComplete: true, CounterpartyEvidencePresent: true})
	if result.Outcome != "internal_record_complete_pending_external_review" {
		t.Fatalf("unexpected outcome: %s", result.Outcome)
	}
	if result.ExternalSubmissionInitiated || result.TravelRuleTransmission || result.ProviderActivationInitiated || result.CustodyInitiated || result.ValueMovementInitiated {
		t.Fatal("evidence evaluator must not create external authority")
	}
}

func TestEvaluateVaspReadinessReportsEvidenceGaps(t *testing.T) {
	result := Evaluate(ReadinessInput{})
	if result.Outcome != "internal_record_incomplete" || len(result.MissingPrerequisites) != 9 {
		t.Fatalf("expected all evidence gaps, got %#v", result)
	}
}
