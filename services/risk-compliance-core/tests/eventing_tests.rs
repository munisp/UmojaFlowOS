use risk_compliance_core::{eventing::policy_event, Decision, PolicyResult};

#[test]
fn policy_events_never_authorize_external_execution() {
    let event = policy_event(
        "event-1".into(),
        "order-1".into(),
        PolicyResult {
            decision: Decision::Allow,
            reason_codes: vec![],
        },
    )
    .unwrap();
    assert!(!event.external_execution_authorized);
}
