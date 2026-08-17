use risk_compliance_core::{evaluate, Corridor, Decision, PolicyInput, ScreeningState};

fn eligible_input() -> PolicyInput {
    PolicyInput {
        corridor: Corridor::SouthAfricaZar,
        regulated_entity_authorized: true,
        counterparty_authorized: true,
        kyc_approved: true,
        sanctions: ScreeningState::Clear,
        travel_rule_required: true,
        travel_rule_complete: true,
        velocity_within_limit: true,
    }
}

#[test]
fn south_africa_travel_rule_incompleteness_blocks_execution() {
    let mut input = eligible_input();
    input.travel_rule_complete = false;
    let result = evaluate(&input);
    assert_eq!(result.decision, Decision::Block);
    assert!(result
        .reason_codes
        .contains(&"TRAVEL_RULE_INCOMPLETE".to_string()));
}

#[test]
fn potential_sanctions_match_requires_manual_review() {
    let mut input = eligible_input();
    input.sanctions = ScreeningState::PotentialMatch;
    let result = evaluate(&input);
    assert_eq!(result.decision, Decision::ManualReview);
}
