// Package tradecontrol provides a non-executable preflight contract. It does not
// call providers, create orders, reserve balances, or instruct settlement.
package tradecontrol

import "sort"

type RehearsalInput struct {
	CaseID                      string   `json:"case_id"`
	Corridor                    string   `json:"corridor"`
	PurchaseCurrency            string   `json:"purchase_currency"`
	DocumentaryEvidenceAccepted bool     `json:"documentary_evidence_accepted"`
	AuthorisedRouteApproved     bool     `json:"authorised_route_approved"`
	IndependentApprovals        []string `json:"independent_approvals"`
	OpenExceptions              int      `json:"open_exceptions"`
	TravelRuleEvidenceAccepted  bool     `json:"travel_rule_evidence_accepted"`
}

type RehearsalResult struct {
	CaseID                     string   `json:"case_id"`
	Outcome                    string   `json:"outcome"`
	MissingPrerequisites       []string `json:"missing_prerequisites"`
	ProviderInstructionCreated bool     `json:"provider_instruction_created"`
	ExternalExecutionInitiated bool     `json:"external_execution_initiated"`
	SettlementCreated          bool     `json:"settlement_created"`
}

func Evaluate(input RehearsalInput) RehearsalResult {
	missing := []string{}
	if input.CaseID == "" {
		missing = append(missing, "case_id_missing")
	}
	if input.Corridor != "NIGERIA_NGN" && input.Corridor != "KENYA_KES" && input.Corridor != "SOUTH_AFRICA_ZAR" {
		missing = append(missing, "supported_corridor_missing")
	}
	if !input.DocumentaryEvidenceAccepted {
		missing = append(missing, "accepted_documentary_evidence_missing")
	}
	if !input.AuthorisedRouteApproved {
		missing = append(missing, "authorised_route_not_approved")
	}
	if input.OpenExceptions > 0 {
		missing = append(missing, "open_trade_case_exception")
	}
	required := map[string]bool{"corporate_trade_sponsor": false, "procurement_owner": false, "trade_finance_operator": false, "compliance_officer": false, "treasury_operator": false}
	for _, approval := range input.IndependentApprovals {
		if _, known := required[approval]; known {
			required[approval] = true
		}
	}
	for role, present := range required {
		if !present {
			missing = append(missing, "approval_missing:"+role)
		}
	}
	if (input.PurchaseCurrency == "USDC" || input.PurchaseCurrency == "USDT") && !input.TravelRuleEvidenceAccepted {
		missing = append(missing, "travel_rule_evidence_missing")
	}
	sort.Strings(missing)
	outcome := "approved_for_authorised_release"
	if len(missing) > 0 {
		outcome = "blocked"
	}
	return RehearsalResult{CaseID: input.CaseID, Outcome: outcome, MissingPrerequisites: missing, ProviderInstructionCreated: false, ExternalExecutionInitiated: false, SettlementCreated: false}
}
