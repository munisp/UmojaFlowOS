// Package enterprisecontrol evaluates internal evidence readiness only. It never
// instructs a bank, provider, funder, custodian, card programme, or settlement rail.
package enterprisecontrol

import "sort"

type GovernanceInput struct {
	Module                       string `json:"module"`
	LegalEntityID                string `json:"legal_entity_id"`
	CounterpartyEvidenceAccepted bool   `json:"counterparty_evidence_accepted"`
	PolicyEvidenceAccepted       bool   `json:"policy_evidence_accepted"`
	IndependentReviewAccepted    bool   `json:"independent_review_accepted"`
	ReconciledReferencePresent   bool   `json:"reconciled_reference_present"`
	StablecoinAsset              string `json:"stablecoin_asset,omitempty"`
	TravelRuleEvidenceAccepted   bool   `json:"travel_rule_evidence_accepted"`
	BeneficiaryEvidenceAccepted  bool   `json:"beneficiary_evidence_accepted"`
}

type GovernanceResult struct {
	Module                      string   `json:"module"`
	Outcome                     string   `json:"outcome"`
	MissingPrerequisites        []string `json:"missing_prerequisites"`
	BankInstructionCreated      bool     `json:"bank_instruction_created"`
	StablecoinTransferInitiated bool     `json:"stablecoin_transfer_initiated"`
	CreditDecisionMade          bool     `json:"credit_decision_made"`
	FundingInitiated            bool     `json:"funding_initiated"`
	CardIssued                  bool     `json:"card_issued"`
	CardAuthorisationInitiated  bool     `json:"card_authorisation_initiated"`
	SettlementInitiated         bool     `json:"settlement_initiated"`
}

type AssuranceInput struct {
	SubjectID                      string `json:"subject_id"`
	ControlCoveragePresent         bool   `json:"control_coverage_present"`
	SeparationOfDutiesClear        bool   `json:"separation_of_duties_clear"`
	EvidenceFresh                  bool   `json:"evidence_fresh"`
	CounterpartyRouteReady         bool   `json:"counterparty_route_ready"`
	ReconciliationReferencePresent bool   `json:"reconciliation_reference_present"`
	StablecoinPolicyCovered        bool   `json:"stablecoin_policy_covered"`
	AdapterCertificationState      string `json:"adapter_certification_state"`
	AuditPacketReferencePresent    bool   `json:"audit_packet_reference_present"`
}

type AssuranceResult struct {
	Outcome                     string   `json:"outcome"`
	MissingPrerequisites        []string `json:"missing_prerequisites"`
	ProviderActivationInitiated bool     `json:"provider_activation_initiated"`
	ExternalExecutionInitiated  bool     `json:"external_execution_initiated"`
	AuditPacketGenerated        bool     `json:"audit_packet_generated"`
}

func EvaluateAssurance(input AssuranceInput) AssuranceResult {
	missing := []string{}
	if input.SubjectID == "" {
		missing = append(missing, "subject_id_missing")
	}
	if !input.ControlCoveragePresent {
		missing = append(missing, "control_coverage_missing")
	}
	if !input.SeparationOfDutiesClear {
		missing = append(missing, "separation_of_duties_conflict")
	}
	if !input.EvidenceFresh {
		missing = append(missing, "evidence_freshness_missing")
	}
	if !input.CounterpartyRouteReady {
		missing = append(missing, "counterparty_route_readiness_missing")
	}
	if !input.ReconciliationReferencePresent {
		missing = append(missing, "reconciliation_reference_missing")
	}
	if !input.StablecoinPolicyCovered {
		missing = append(missing, "stablecoin_policy_coverage_missing")
	}
	if input.AdapterCertificationState != "ready_for_controlled_test" {
		missing = append(missing, "adapter_certification_not_ready")
	}
	if !input.AuditPacketReferencePresent {
		missing = append(missing, "audit_packet_reference_missing")
	}
	sort.Strings(missing)
	outcome := "assurance_ready_for_independent_review"
	if len(missing) > 0 {
		outcome = "blocked"
	}
	return AssuranceResult{Outcome: outcome, MissingPrerequisites: missing, ProviderActivationInitiated: false, ExternalExecutionInitiated: false, AuditPacketGenerated: false}
}

func Evaluate(input GovernanceInput) GovernanceResult {
	missing := []string{}
	validModules := map[string]bool{"multi_bank_treasury": true, "stablecoin_treasury": true, "supply_chain_finance": true, "spend_card_programme": true}
	if !validModules[input.Module] {
		missing = append(missing, "supported_governance_module_missing")
	}
	if input.LegalEntityID == "" {
		missing = append(missing, "legal_entity_id_missing")
	}
	if !input.CounterpartyEvidenceAccepted {
		missing = append(missing, "counterparty_evidence_missing")
	}
	if !input.PolicyEvidenceAccepted {
		missing = append(missing, "policy_evidence_missing")
	}
	if !input.IndependentReviewAccepted {
		missing = append(missing, "independent_review_missing")
	}
	if !input.ReconciledReferencePresent {
		missing = append(missing, "reconciled_reference_missing")
	}
	if input.Module == "stablecoin_treasury" {
		if input.StablecoinAsset != "USDC" && input.StablecoinAsset != "USDT" {
			missing = append(missing, "supported_stablecoin_asset_missing")
		}
		if !input.TravelRuleEvidenceAccepted {
			missing = append(missing, "travel_rule_evidence_missing")
		}
		if !input.BeneficiaryEvidenceAccepted {
			missing = append(missing, "beneficiary_evidence_missing")
		}
	}
	sort.Strings(missing)
	outcome := "evidence_ready_for_authorised_path"
	if len(missing) > 0 {
		outcome = "blocked"
	}
	return GovernanceResult{Module: input.Module, Outcome: outcome, MissingPrerequisites: missing, BankInstructionCreated: false, StablecoinTransferInitiated: false, CreditDecisionMade: false, FundingInitiated: false, CardIssued: false, CardAuthorisationInitiated: false, SettlementInitiated: false}
}
