//! Rules-based transaction monitoring for the Nigeria (NGN), Kenya (KES), and
//! South Africa (ZAR) corridors.
//!
//! Every rule is deterministic and evaluated only from supplied, reconciled
//! inputs. There is no default, no assumed threshold, and no inferred history:
//! when a required input is absent the evaluation fails closed with an explicit
//! `INPUT_UNAVAILABLE_*` reason code rather than returning a permissive result.
//!
//! This module produces monitoring findings only. It never approves a payment,
//! never files a report, and never resolves an alert; disposition remains a
//! human compliance decision recorded in the control plane.

use crate::{Corridor, Decision};
use serde::{Deserialize, Serialize};

/// A single rule outcome. `triggered` means the rule's condition was met on the
/// supplied evidence, not that a violation has been established.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleFinding {
    pub rule_id: String,
    pub triggered: bool,
    pub reason_code: String,
}

/// Reconciled monitoring inputs. Optional fields are genuinely optional inputs:
/// `None` means "not supplied", which forces a fail-closed finding rather than a
/// zero or a guess.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MonitoringInput {
    pub corridor: Corridor,
    /// Amount of the transaction under evaluation, in minor units.
    pub amount_minor_units: Option<i128>,
    /// Corridor reporting threshold in minor units, sourced from the approved
    /// corridor policy record. Never defaulted.
    pub reporting_threshold_minor_units: Option<i128>,
    /// Count of transactions by the same customer inside the configured window.
    pub customer_transactions_in_window: Option<u32>,
    /// Configured maximum transactions per window from the approved policy.
    pub max_transactions_per_window: Option<u32>,
    /// Aggregate value by the same customer inside the window, in minor units.
    pub customer_value_in_window_minor_units: Option<i128>,
    /// Configured maximum aggregate value per window from the approved policy.
    pub max_value_per_window_minor_units: Option<i128>,
    /// True when the counterparty holds a verified regulator licence record.
    pub counterparty_licence_verified: Option<bool>,
    /// True when the beneficiary jurisdiction matches the corridor's expected
    /// destination per the approved corridor policy.
    pub beneficiary_jurisdiction_expected: Option<bool>,
}

/// Aggregate monitoring outcome.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonitoringResult {
    pub decision: Decision,
    pub findings: Vec<RuleFinding>,
}

fn finding(rule_id: &str, triggered: bool, reason_code: &str) -> RuleFinding {
    RuleFinding {
        rule_id: rule_id.to_string(),
        triggered,
        reason_code: reason_code.to_string(),
    }
}

/// Evaluate all monitoring rules.
///
/// Any missing input produces a `Block` with an `INPUT_UNAVAILABLE_*` reason.
/// A triggered structuring, velocity, or unverified-counterparty rule escalates
/// to `ManualReview`; nothing here can produce an automatic approval beyond
/// "no rule triggered on complete inputs".
pub fn evaluate_monitoring(input: &MonitoringInput) -> MonitoringResult {
    let mut findings = Vec::new();
    let mut unavailable = false;

    // Rule TM-01: value at or above the corridor reporting threshold.
    match (
        input.amount_minor_units,
        input.reporting_threshold_minor_units,
    ) {
        (Some(amount), Some(threshold)) => findings.push(finding(
            "TM-01-REPORTING-THRESHOLD",
            amount >= threshold,
            "AMOUNT_AT_OR_ABOVE_REPORTING_THRESHOLD",
        )),
        _ => {
            unavailable = true;
            findings.push(finding(
                "TM-01-REPORTING-THRESHOLD",
                false,
                "INPUT_UNAVAILABLE_REPORTING_THRESHOLD",
            ));
        }
    }

    // Rule TM-02: structuring, value just below the threshold within the window.
    match (
        input.amount_minor_units,
        input.reporting_threshold_minor_units,
        input.customer_transactions_in_window,
    ) {
        (Some(amount), Some(threshold), Some(count)) => {
            // Deterministic band: within 10% below the threshold, repeated.
            let band_floor = threshold - threshold / 10;
            let triggered = amount < threshold && amount >= band_floor && count > 1;
            findings.push(finding(
                "TM-02-STRUCTURING-BAND",
                triggered,
                "REPEATED_VALUE_JUST_BELOW_THRESHOLD",
            ));
        }
        _ => {
            unavailable = true;
            findings.push(finding(
                "TM-02-STRUCTURING-BAND",
                false,
                "INPUT_UNAVAILABLE_STRUCTURING_INPUTS",
            ));
        }
    }

    // Rule TM-03: transaction-count velocity.
    match (
        input.customer_transactions_in_window,
        input.max_transactions_per_window,
    ) {
        (Some(count), Some(max)) => findings.push(finding(
            "TM-03-COUNT-VELOCITY",
            count > max,
            "TRANSACTION_COUNT_VELOCITY_EXCEEDED",
        )),
        _ => {
            unavailable = true;
            findings.push(finding(
                "TM-03-COUNT-VELOCITY",
                false,
                "INPUT_UNAVAILABLE_COUNT_VELOCITY_LIMIT",
            ));
        }
    }

    // Rule TM-04: aggregate-value velocity.
    match (
        input.customer_value_in_window_minor_units,
        input.max_value_per_window_minor_units,
    ) {
        (Some(value), Some(max)) => findings.push(finding(
            "TM-04-VALUE-VELOCITY",
            value > max,
            "AGGREGATE_VALUE_VELOCITY_EXCEEDED",
        )),
        _ => {
            unavailable = true;
            findings.push(finding(
                "TM-04-VALUE-VELOCITY",
                false,
                "INPUT_UNAVAILABLE_VALUE_VELOCITY_LIMIT",
            ));
        }
    }

    // Rule TM-05: counterparty licence verification.
    match input.counterparty_licence_verified {
        Some(verified) => findings.push(finding(
            "TM-05-COUNTERPARTY-LICENCE",
            !verified,
            "COUNTERPARTY_LICENCE_NOT_VERIFIED",
        )),
        None => {
            unavailable = true;
            findings.push(finding(
                "TM-05-COUNTERPARTY-LICENCE",
                false,
                "INPUT_UNAVAILABLE_COUNTERPARTY_LICENCE",
            ));
        }
    }

    // Rule TM-06: unexpected beneficiary jurisdiction for the corridor.
    match input.beneficiary_jurisdiction_expected {
        Some(expected) => findings.push(finding(
            "TM-06-JURISDICTION",
            !expected,
            "BENEFICIARY_JURISDICTION_UNEXPECTED",
        )),
        None => {
            unavailable = true;
            findings.push(finding(
                "TM-06-JURISDICTION",
                false,
                "INPUT_UNAVAILABLE_BENEFICIARY_JURISDICTION",
            ));
        }
    }

    if unavailable {
        return MonitoringResult {
            decision: Decision::Block,
            findings,
        };
    }

    let escalate = findings.iter().any(|f| f.triggered);
    MonitoringResult {
        decision: if escalate {
            Decision::ManualReview
        } else {
            Decision::Allow
        },
        findings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn complete() -> MonitoringInput {
        MonitoringInput {
            corridor: Corridor::KenyaKes,
            amount_minor_units: Some(50_000),
            reporting_threshold_minor_units: Some(1_000_000),
            customer_transactions_in_window: Some(1),
            max_transactions_per_window: Some(10),
            customer_value_in_window_minor_units: Some(50_000),
            max_value_per_window_minor_units: Some(5_000_000),
            counterparty_licence_verified: Some(true),
            beneficiary_jurisdiction_expected: Some(true),
        }
    }

    #[test]
    fn allows_when_all_inputs_present_and_no_rule_triggers() {
        let result = evaluate_monitoring(&complete());
        assert_eq!(result.decision, Decision::Allow);
        assert!(result.findings.iter().all(|f| !f.triggered));
        assert_eq!(result.findings.len(), 6);
    }

    #[test]
    fn blocks_when_any_required_input_is_missing() {
        let mut input = complete();
        input.reporting_threshold_minor_units = None;
        let result = evaluate_monitoring(&input);
        assert_eq!(result.decision, Decision::Block);
        assert!(result
            .findings
            .iter()
            .any(|f| f.reason_code == "INPUT_UNAVAILABLE_REPORTING_THRESHOLD"));
    }

    #[test]
    fn blocks_when_every_limit_is_absent_rather_than_assuming_zero() {
        let mut input = complete();
        input.max_transactions_per_window = None;
        input.max_value_per_window_minor_units = None;
        let result = evaluate_monitoring(&input);
        assert_eq!(result.decision, Decision::Block);
        let unavailable = result
            .findings
            .iter()
            .filter(|f| f.reason_code.starts_with("INPUT_UNAVAILABLE"))
            .count();
        assert_eq!(unavailable, 2);
    }

    #[test]
    fn escalates_at_or_above_the_reporting_threshold() {
        let mut input = complete();
        input.amount_minor_units = Some(1_000_000);
        let result = evaluate_monitoring(&input);
        assert_eq!(result.decision, Decision::ManualReview);
        assert!(result
            .findings
            .iter()
            .any(|f| f.rule_id == "TM-01-REPORTING-THRESHOLD" && f.triggered));
    }

    #[test]
    fn detects_repeated_value_just_below_the_threshold() {
        let mut input = complete();
        input.amount_minor_units = Some(950_000);
        input.customer_transactions_in_window = Some(3);
        let result = evaluate_monitoring(&input);
        assert_eq!(result.decision, Decision::ManualReview);
        assert!(result
            .findings
            .iter()
            .any(|f| f.rule_id == "TM-02-STRUCTURING-BAND" && f.triggered));
    }

    #[test]
    fn does_not_flag_a_single_transaction_in_the_structuring_band() {
        let mut input = complete();
        input.amount_minor_units = Some(950_000);
        input.customer_transactions_in_window = Some(1);
        let result = evaluate_monitoring(&input);
        assert!(result
            .findings
            .iter()
            .any(|f| f.rule_id == "TM-02-STRUCTURING-BAND" && !f.triggered));
    }

    #[test]
    fn escalates_on_count_and_value_velocity_breaches() {
        let mut input = complete();
        input.customer_transactions_in_window = Some(11);
        input.customer_value_in_window_minor_units = Some(5_000_001);
        let result = evaluate_monitoring(&input);
        assert_eq!(result.decision, Decision::ManualReview);
        assert!(result
            .findings
            .iter()
            .any(|f| f.rule_id == "TM-03-COUNT-VELOCITY" && f.triggered));
        assert!(result
            .findings
            .iter()
            .any(|f| f.rule_id == "TM-04-VALUE-VELOCITY" && f.triggered));
    }

    #[test]
    fn escalates_an_unverified_counterparty_and_unexpected_jurisdiction() {
        let mut input = complete();
        input.counterparty_licence_verified = Some(false);
        input.beneficiary_jurisdiction_expected = Some(false);
        let result = evaluate_monitoring(&input);
        assert_eq!(result.decision, Decision::ManualReview);
        assert!(result
            .findings
            .iter()
            .any(|f| f.rule_id == "TM-05-COUNTERPARTY-LICENCE" && f.triggered));
        assert!(result
            .findings
            .iter()
            .any(|f| f.rule_id == "TM-06-JURISDICTION" && f.triggered));
    }

    #[test]
    fn never_returns_a_settlement_or_filing_instruction() {
        // The result type carries a decision and findings only. This guards
        // against a future field that could be read as an execution instruction.
        let json = serde_json::to_string(&evaluate_monitoring(&complete())).expect("serialize");
        for forbidden in ["execute", "settle", "submit", "file_report", "transfer"] {
            assert!(
                !json.contains(forbidden),
                "monitoring result must not carry {forbidden}"
            );
        }
    }
}
