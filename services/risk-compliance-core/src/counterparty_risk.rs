//! Deterministic counterparty risk assessment.
//!
//! The score is a pure function of supplied, evidenced attributes. There is no
//! statistical model, no learned weighting, and no historical inference, because
//! none of those inputs exist without authorised provider data. Missing evidence
//! yields `RiskBand::Undetermined`, never a favourable band.
//!
//! The output informs a human review decision. It does not authorise a
//! counterparty, does not open an integration, and does not approve a payment.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RiskBand {
    /// Required evidence is absent; no band may be asserted.
    Undetermined,
    Low,
    Medium,
    High,
    /// A prohibitive finding: review cannot clear this counterparty as-is.
    Prohibited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LicenceStatus {
    Verified,
    PendingReview,
    Expired,
    Suspended,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CounterpartyRiskInput {
    /// Regulator licence status from the counterparty authorisation record.
    pub licence_status: Option<LicenceStatus>,
    /// True when the licence's validity window covers the assessment date.
    pub licence_within_validity_window: Option<bool>,
    /// True when a sanctions screening result exists and is clear.
    pub sanctions_clear: Option<bool>,
    /// True when adverse-media or enforcement findings were recorded.
    pub adverse_findings_recorded: Option<bool>,
    /// Days since the last completed review; `None` means never reviewed.
    pub days_since_last_review: Option<u32>,
    /// Maximum review age permitted by the approved policy, in days.
    pub review_interval_days: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CounterpartyRiskAssessment {
    pub band: RiskBand,
    pub reason_codes: Vec<String>,
    /// True when a human review must be scheduled or refreshed.
    pub review_required: bool,
}

/// Assess counterparty risk from evidenced attributes only.
pub fn assess_counterparty_risk(input: &CounterpartyRiskInput) -> CounterpartyRiskAssessment {
    let mut reasons: Vec<String> = Vec::new();

    // Absent evidence is never treated as favourable.
    let mut missing = Vec::new();
    if input.licence_status.is_none() {
        missing.push("INPUT_UNAVAILABLE_LICENCE_STATUS");
    }
    if input.licence_within_validity_window.is_none() {
        missing.push("INPUT_UNAVAILABLE_LICENCE_VALIDITY");
    }
    if input.sanctions_clear.is_none() {
        missing.push("INPUT_UNAVAILABLE_SANCTIONS_RESULT");
    }
    if input.adverse_findings_recorded.is_none() {
        missing.push("INPUT_UNAVAILABLE_ADVERSE_FINDINGS");
    }
    if input.review_interval_days.is_none() {
        missing.push("INPUT_UNAVAILABLE_REVIEW_INTERVAL");
    }
    if !missing.is_empty() {
        return CounterpartyRiskAssessment {
            band: RiskBand::Undetermined,
            reason_codes: missing.into_iter().map(str::to_string).collect(),
            review_required: true,
        };
    }

    let licence_status = input.licence_status.expect("checked above");
    let within_window = input.licence_within_validity_window.expect("checked above");
    let sanctions_clear = input.sanctions_clear.expect("checked above");
    let adverse = input.adverse_findings_recorded.expect("checked above");
    let interval = input.review_interval_days.expect("checked above");

    // Prohibitive findings short-circuit: no combination of other evidence can
    // downgrade these to an acceptable band.
    if matches!(
        licence_status,
        LicenceStatus::Rejected | LicenceStatus::Suspended
    ) {
        reasons.push(format!("LICENCE_{licence_status:?}").to_uppercase());
        return CounterpartyRiskAssessment {
            band: RiskBand::Prohibited,
            reason_codes: reasons,
            review_required: true,
        };
    }
    if !sanctions_clear {
        reasons.push("SANCTIONS_NOT_CLEAR".to_string());
        return CounterpartyRiskAssessment {
            band: RiskBand::Prohibited,
            reason_codes: reasons,
            review_required: true,
        };
    }

    // Additive, fully auditable point contributions.
    let mut points: u32 = 0;
    if licence_status == LicenceStatus::PendingReview {
        points += 2;
        reasons.push("LICENCE_PENDING_REVIEW".to_string());
    }
    if licence_status == LicenceStatus::Expired {
        points += 3;
        reasons.push("LICENCE_EXPIRED".to_string());
    }
    if !within_window {
        points += 2;
        reasons.push("LICENCE_OUTSIDE_VALIDITY_WINDOW".to_string());
    }
    if adverse {
        points += 2;
        reasons.push("ADVERSE_FINDINGS_RECORDED".to_string());
    }

    let review_overdue = match input.days_since_last_review {
        None => {
            points += 2;
            reasons.push("NEVER_REVIEWED".to_string());
            true
        }
        Some(days) if days > interval => {
            points += 1;
            reasons.push("REVIEW_OVERDUE".to_string());
            true
        }
        Some(_) => false,
    };

    let band = match points {
        0 => RiskBand::Low,
        1..=2 => RiskBand::Medium,
        _ => RiskBand::High,
    };

    CounterpartyRiskAssessment {
        band,
        reason_codes: reasons,
        review_required: review_overdue || band != RiskBand::Low,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clean() -> CounterpartyRiskInput {
        CounterpartyRiskInput {
            licence_status: Some(LicenceStatus::Verified),
            licence_within_validity_window: Some(true),
            sanctions_clear: Some(true),
            adverse_findings_recorded: Some(false),
            days_since_last_review: Some(30),
            review_interval_days: Some(365),
        }
    }

    #[test]
    fn returns_low_band_only_on_complete_clean_evidence() {
        let assessment = assess_counterparty_risk(&clean());
        assert_eq!(assessment.band, RiskBand::Low);
        assert!(!assessment.review_required);
        assert!(assessment.reason_codes.is_empty());
    }

    #[test]
    fn missing_evidence_yields_undetermined_never_low() {
        for mutate in [
            (|i: &mut CounterpartyRiskInput| i.licence_status = None)
                as fn(&mut CounterpartyRiskInput),
            |i: &mut CounterpartyRiskInput| i.sanctions_clear = None,
            |i: &mut CounterpartyRiskInput| i.adverse_findings_recorded = None,
            |i: &mut CounterpartyRiskInput| i.review_interval_days = None,
            |i: &mut CounterpartyRiskInput| i.licence_within_validity_window = None,
        ] {
            let mut input = clean();
            mutate(&mut input);
            let assessment = assess_counterparty_risk(&input);
            assert_eq!(assessment.band, RiskBand::Undetermined);
            assert!(assessment.review_required);
            assert!(assessment
                .reason_codes
                .iter()
                .all(|code| code.starts_with("INPUT_UNAVAILABLE")));
        }
    }

    #[test]
    fn a_suspended_or_rejected_licence_is_prohibited() {
        for status in [LicenceStatus::Suspended, LicenceStatus::Rejected] {
            let mut input = clean();
            input.licence_status = Some(status);
            assert_eq!(assess_counterparty_risk(&input).band, RiskBand::Prohibited);
        }
    }

    #[test]
    fn a_non_clear_sanctions_result_is_prohibited_regardless_of_other_evidence() {
        let mut input = clean();
        input.sanctions_clear = Some(false);
        input.licence_status = Some(LicenceStatus::Verified);
        let assessment = assess_counterparty_risk(&input);
        assert_eq!(assessment.band, RiskBand::Prohibited);
        assert!(assessment
            .reason_codes
            .contains(&"SANCTIONS_NOT_CLEAR".to_string()));
    }

    #[test]
    fn an_expired_licence_with_adverse_findings_scores_high() {
        let mut input = clean();
        input.licence_status = Some(LicenceStatus::Expired);
        input.adverse_findings_recorded = Some(true);
        let assessment = assess_counterparty_risk(&input);
        assert_eq!(assessment.band, RiskBand::High);
        assert!(assessment.review_required);
    }

    #[test]
    fn a_never_reviewed_counterparty_always_requires_review() {
        let mut input = clean();
        input.days_since_last_review = None;
        let assessment = assess_counterparty_risk(&input);
        assert!(assessment.review_required);
        assert!(assessment
            .reason_codes
            .contains(&"NEVER_REVIEWED".to_string()));
        assert_ne!(assessment.band, RiskBand::Low);
    }

    #[test]
    fn an_overdue_review_is_flagged_against_the_configured_interval() {
        let mut input = clean();
        input.days_since_last_review = Some(400);
        let assessment = assess_counterparty_risk(&input);
        assert!(assessment.review_required);
        assert!(assessment
            .reason_codes
            .contains(&"REVIEW_OVERDUE".to_string()));
    }

    #[test]
    fn scoring_is_deterministic_across_repeated_evaluations() {
        let input = clean();
        let first = assess_counterparty_risk(&input);
        for _ in 0..25 {
            assert_eq!(assess_counterparty_risk(&input), first);
        }
    }
}
