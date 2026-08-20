use risk_compliance_core::{assess_vasp_readiness, VaspReadinessRiskInput};

#[test]
fn vasp_readiness_reports_gaps_and_never_creates_authority() {
    let decision = assess_vasp_readiness(VaspReadinessRiskInput {
        supervisory_path_evidence_present: true,
        corporate_evidence_present: true,
        principal_officer_evidence_present: true,
        nfiu_evidence_present: true,
        aml_programme_present: true,
        cyber_controls_present: true,
        incident_plan_present: true,
        travel_rule_data_complete: true,
        counterparty_evidence_present: true,
    });
    assert_eq!(
        decision.outcome,
        "INTERNAL_RECORD_COMPLETE_PENDING_EXTERNAL_REVIEW"
    );
    assert!(!decision.external_submission_initiated);
    assert!(!decision.travel_rule_transmission);
    assert!(!decision.provider_activation_initiated);
    assert!(!decision.custody_initiated);
    assert!(!decision.value_movement_initiated);
}
