#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Corridor {
    NigeriaNgn,
    KenyaKes,
    SouthAfricaZar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreeningState {
    Clear,
    PotentialMatch,
    ConfirmedMatch,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    ManualReview,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq)]
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyResult {
    pub decision: Decision,
    pub reason_codes: Vec<&'static str>,
}

pub fn evaluate(input: &PolicyInput) -> PolicyResult {
    let mut reasons = Vec::new();
    if !input.regulated_entity_authorized {
        reasons.push("REGULATED_ENTITY_NOT_AUTHORIZED");
    }
    if !input.counterparty_authorized {
        reasons.push("COUNTERPARTY_NOT_AUTHORIZED");
    }
    if !input.kyc_approved {
        reasons.push("KYC_NOT_APPROVED");
    }
    if input.sanctions == ScreeningState::ConfirmedMatch {
        reasons.push("SANCTIONS_CONFIRMED_MATCH");
    }
    if input.sanctions == ScreeningState::Unavailable {
        reasons.push("SANCTIONS_SOURCE_UNAVAILABLE");
    }
    if !input.velocity_within_limit {
        reasons.push("VELOCITY_LIMIT_EXCEEDED");
    }
    if input.travel_rule_required && !input.travel_rule_complete {
        reasons.push("TRAVEL_RULE_INCOMPLETE");
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
            reason_codes: vec!["SANCTIONS_POTENTIAL_MATCH"],
        };
    }
    PolicyResult {
        decision: Decision::Allow,
        reason_codes: Vec::new(),
    }
}
