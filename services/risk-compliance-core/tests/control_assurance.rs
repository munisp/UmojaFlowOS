use risk_compliance_core::{assess_control_assurance, ControlAssuranceRiskInput};

#[test]
fn incomplete_assurance_is_blocked_without_activation_or_execution_authority() {
    let decision = assess_control_assurance(ControlAssuranceRiskInput {
        control_coverage_present: false,
        separation_of_duties_clear: false,
        evidence_fresh: false,
        counterparty_route_ready: false,
        reconciliation_reference_present: false,
        stablecoin_policy_covered: false,
        adapter_certification_state: "evidence_pending".to_owned(),
        audit_packet_reference_present: false,
    });

    assert_eq!(decision.outcome, "blocked");
    assert!(!decision.provider_activation_initiated);
    assert!(!decision.external_execution_initiated);
    assert!(!decision.audit_packet_generated);
    assert_eq!(decision.reason_codes.len(), 8);
}
