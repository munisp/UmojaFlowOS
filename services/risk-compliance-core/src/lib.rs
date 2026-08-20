use serde::{Deserialize, Serialize};
pub mod counterparty_risk;
pub mod eventing;
pub mod monitoring;
pub mod treasury_stress;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Corridor {
    NigeriaNgn,
    KenyaKes,
    SouthAfricaZar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ScreeningState {
    Clear,
    PotentialMatch,
    ConfirmedMatch,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Decision {
    Allow,
    ManualReview,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyInput {
    pub corridor: Corridor,
    pub regulated_entity_authorized: bool,
    pub counterparty_authorized: bool,
    pub kyc_approved: bool,
    pub sanctions: ScreeningState,
    pub travel_rule_required: bool,
    pub travel_rule_complete: bool,
    pub velocity_within_limit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyResult {
    pub decision: Decision,
    pub reason_codes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlAssuranceRiskInput {
    pub control_coverage_present: bool,
    pub separation_of_duties_clear: bool,
    pub evidence_fresh: bool,
    pub counterparty_route_ready: bool,
    pub reconciliation_reference_present: bool,
    pub stablecoin_policy_covered: bool,
    pub adapter_certification_state: String,
    pub audit_packet_reference_present: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ControlAssuranceRiskDecision {
    pub outcome: String,
    pub reason_codes: Vec<String>,
    pub provider_activation_initiated: bool,
    pub external_execution_initiated: bool,
    pub audit_packet_generated: bool,
}

pub fn assess_control_assurance(input: ControlAssuranceRiskInput) -> ControlAssuranceRiskDecision {
    let mut reasons = Vec::new();
    if !input.control_coverage_present {
        reasons.push("control_coverage_missing".to_owned());
    }
    if !input.separation_of_duties_clear {
        reasons.push("separation_of_duties_conflict".to_owned());
    }
    if !input.evidence_fresh {
        reasons.push("evidence_freshness_missing".to_owned());
    }
    if !input.counterparty_route_ready {
        reasons.push("counterparty_route_readiness_missing".to_owned());
    }
    if !input.reconciliation_reference_present {
        reasons.push("reconciliation_reference_missing".to_owned());
    }
    if !input.stablecoin_policy_covered {
        reasons.push("stablecoin_policy_coverage_missing".to_owned());
    }
    if input.adapter_certification_state != "ready_for_controlled_test" {
        reasons.push("adapter_certification_not_ready".to_owned());
    }
    if !input.audit_packet_reference_present {
        reasons.push("audit_packet_reference_missing".to_owned());
    }
    reasons.sort();

    ControlAssuranceRiskDecision {
        outcome: if reasons.is_empty() {
            "assurance_ready_for_independent_review".to_owned()
        } else {
            "blocked".to_owned()
        },
        reason_codes: reasons,
        provider_activation_initiated: false,
        external_execution_initiated: false,
        audit_packet_generated: false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EventStreamState {
    Available,
    InputUnavailable,
}

pub fn evaluate(input: &PolicyInput) -> PolicyResult {
    let mut reasons = Vec::new();
    if !input.regulated_entity_authorized {
        reasons.push("REGULATED_ENTITY_NOT_AUTHORIZED".to_string());
    }
    if !input.counterparty_authorized {
        reasons.push("COUNTERPARTY_NOT_AUTHORIZED".to_string());
    }
    if !input.kyc_approved {
        reasons.push("KYC_NOT_APPROVED".to_string());
    }
    if input.sanctions == ScreeningState::ConfirmedMatch {
        reasons.push("SANCTIONS_CONFIRMED_MATCH".to_string());
    }
    if input.sanctions == ScreeningState::Unavailable {
        reasons.push("SANCTIONS_SOURCE_UNAVAILABLE".to_string());
    }
    if !input.velocity_within_limit {
        reasons.push("VELOCITY_LIMIT_EXCEEDED".to_string());
    }
    if input.travel_rule_required && !input.travel_rule_complete {
        reasons.push("TRAVEL_RULE_INCOMPLETE".to_string());
    }
    if !reasons.is_empty() {
        return PolicyResult {
            decision: Decision::Block,
            reason_codes: reasons,
        };
    }
    if input.sanctions == ScreeningState::PotentialMatch {
        return PolicyResult {
            decision: Decision::ManualReview,
            reason_codes: vec!["SANCTIONS_POTENTIAL_MATCH".to_string()],
        };
    }
    PolicyResult {
        decision: Decision::Allow,
        reason_codes: Vec::new(),
    }
}

pub fn evaluate_event_stream_input(
    input: &PolicyInput,
    stream_state: EventStreamState,
) -> PolicyResult {
    if stream_state == EventStreamState::InputUnavailable {
        return PolicyResult {
            decision: Decision::Block,
            reason_codes: vec!["INPUT_UNAVAILABLE_EVENT_STREAM".to_string()],
        };
    }
    evaluate(input)
}
