// Package vaspcontrol evaluates regulatory-readiness evidence only. It never
// submits an application, transmits Travel Rule data, activates a provider,
// opens custody, or instructs value movement.
package vaspcontrol

import "sort"

type ReadinessInput struct {
	SupervisoryPathEvidencePresent  bool `json:"supervisory_path_evidence_present"`
	CorporateEvidencePresent        bool `json:"corporate_evidence_present"`
	PrincipalOfficerEvidencePresent bool `json:"principal_officer_evidence_present"`
	NFIUEvidencePresent             bool `json:"nfiu_evidence_present"`
	AMLProgrammePresent             bool `json:"aml_programme_present"`
	CyberControlsPresent            bool `json:"cyber_controls_present"`
	IncidentPlanPresent             bool `json:"incident_plan_present"`
	TravelRuleDataComplete          bool `json:"travel_rule_data_complete"`
	CounterpartyEvidencePresent     bool `json:"counterparty_evidence_present"`
}

type ReadinessResult struct {
	Outcome                     string   `json:"outcome"`
	MissingPrerequisites        []string `json:"missing_prerequisites"`
	ExternalSubmissionInitiated bool     `json:"external_submission_initiated"`
	TravelRuleTransmission      bool     `json:"travel_rule_transmission"`
	ProviderActivationInitiated bool     `json:"provider_activation_initiated"`
	CustodyInitiated            bool     `json:"custody_initiated"`
	ValueMovementInitiated      bool     `json:"value_movement_initiated"`
}

func Evaluate(input ReadinessInput) ReadinessResult {
	missing := []string{}
	if !input.SupervisoryPathEvidencePresent {
		missing = append(missing, "supervisory_path_evidence_missing")
	}
	if !input.CorporateEvidencePresent {
		missing = append(missing, "corporate_evidence_missing")
	}
	if !input.PrincipalOfficerEvidencePresent {
		missing = append(missing, "principal_officer_evidence_missing")
	}
	if !input.NFIUEvidencePresent {
		missing = append(missing, "nfiu_evidence_missing")
	}
	if !input.AMLProgrammePresent {
		missing = append(missing, "aml_cft_cpf_programme_missing")
	}
	if !input.CyberControlsPresent {
		missing = append(missing, "cyber_controls_missing")
	}
	if !input.IncidentPlanPresent {
		missing = append(missing, "incident_reporting_plan_missing")
	}
	if !input.TravelRuleDataComplete {
		missing = append(missing, "travel_rule_data_missing")
	}
	if !input.CounterpartyEvidencePresent {
		missing = append(missing, "counterparty_evidence_missing")
	}
	sort.Strings(missing)
	outcome := "internal_record_complete_pending_external_review"
	if len(missing) > 0 {
		outcome = "internal_record_incomplete"
	}
	return ReadinessResult{Outcome: outcome, MissingPrerequisites: missing, ExternalSubmissionInitiated: false, TravelRuleTransmission: false, ProviderActivationInitiated: false, CustodyInitiated: false, ValueMovementInitiated: false}
}
