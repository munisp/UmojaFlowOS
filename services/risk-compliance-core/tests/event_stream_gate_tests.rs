use risk_compliance_core::{
    evaluate_event_stream_input, Corridor, Decision, EventStreamState, PolicyInput, ScreeningState,
};

fn otherwise_allowed_input() -> PolicyInput {
    PolicyInput {
        corridor: Corridor::NigeriaNgn,
        regulated_entity_authorized: true,
        counterparty_authorized: true,
        kyc_approved: true,
        sanctions: ScreeningState::Clear,
        travel_rule_required: false,
        travel_rule_complete: true,
        velocity_within_limit: true,
    }
}

#[test]
fn missing_kafka_or_dapr_input_fails_closed_before_policy_allow() {
    let result = evaluate_event_stream_input(
        &otherwise_allowed_input(),
        EventStreamState::InputUnavailable,
    );
    assert_eq!(result.decision, Decision::Block);
    assert_eq!(result.reason_codes, vec!["INPUT_UNAVAILABLE_EVENT_STREAM"]);
}

#[test]
fn available_event_stream_delegates_to_standard_policy_evaluation() {
    let result =
        evaluate_event_stream_input(&otherwise_allowed_input(), EventStreamState::Available);
    assert_eq!(result.decision, Decision::Allow);
}
