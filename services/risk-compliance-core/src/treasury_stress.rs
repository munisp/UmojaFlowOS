//! Deterministic, fail-closed treasury stress-test evaluation.
//!
//! The evaluator is intentionally pure: it derives stressed buffer thresholds
//! and a bounded recommendation amount from an approved buffer policy and a
//! reconciled balance observation. It never invents a balance, never fetches
//! market data, and never initiates a transfer. When any required input is
//! missing, stale, or internally inconsistent, the run is classified as
//! unavailable and no numeric result is produced, so downstream persistence
//! cannot record a decision that was not actually computed.

use serde::{Deserialize, Serialize};

use crate::Corridor;

/// Maximum age of a reconciled balance observation, in hours, before the
/// evaluator refuses to use it. Treasury decisions must not be taken on a
/// balance that is no longer representative of the account state.
pub const MAX_BALANCE_AGE_HOURS: u32 = 24;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StressTestStatus {
    Completed,
    InputUnavailable,
    InputStale,
    InputInconsistent,
}

/// An approved treasury buffer policy. Percentages are expressed as fractions
/// of the approved daily outflow (for example, 0.35 means 35 percent).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BufferPolicy {
    pub corridor: Corridor,
    pub currency: String,
    pub policy_version: String,
    pub approved_daily_outflow: f64,
    pub minimum_buffer_pct: f64,
    pub amber_buffer_pct: f64,
    pub target_buffer_pct: f64,
    pub max_recommendation_pct_of_target: f64,
}

/// A reconciled balance observation supplied by an authorised source.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReconciledBalance {
    pub available_amount: f64,
    pub age_hours: u32,
    pub source_reference: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StressScenario {
    pub scenario_code: String,
    /// Multiplier applied to the approved daily outflow. A 50 percent surge is
    /// expressed as 1.5 and must never be below 1.0.
    pub outflow_multiplier: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StressTestOutcome {
    pub status: StressTestStatus,
    pub scenario_code: String,
    pub outflow_multiplier: f64,
    pub reconciled_available_balance: Option<f64>,
    pub stressed_daily_outflow: Option<f64>,
    pub stressed_minimum_buffer: Option<f64>,
    pub stressed_amber_buffer: Option<f64>,
    pub stressed_target_buffer: Option<f64>,
    pub computed_recommendation_amount: Option<f64>,
    pub breaches_minimum_buffer: Option<bool>,
    pub limitation: Option<String>,
    pub reason_codes: Vec<String>,
}

impl StressTestOutcome {
    fn fail_closed(
        scenario: &StressScenario,
        status: StressTestStatus,
        limitation: &str,
        reason_code: &str,
    ) -> Self {
        Self {
            status,
            scenario_code: scenario.scenario_code.clone(),
            outflow_multiplier: scenario.outflow_multiplier,
            reconciled_available_balance: None,
            stressed_daily_outflow: None,
            stressed_minimum_buffer: None,
            stressed_amber_buffer: None,
            stressed_target_buffer: None,
            computed_recommendation_amount: None,
            breaches_minimum_buffer: None,
            limitation: Some(limitation.to_string()),
            reason_codes: vec![reason_code.to_string()],
        }
    }
}

fn policy_is_consistent(policy: &BufferPolicy) -> bool {
    let fractions_in_range = [
        policy.minimum_buffer_pct,
        policy.amber_buffer_pct,
        policy.target_buffer_pct,
        policy.max_recommendation_pct_of_target,
    ]
    .iter()
    .all(|value| value.is_finite() && *value > 0.0 && *value <= 1.0);

    fractions_in_range
        && policy.approved_daily_outflow.is_finite()
        && policy.approved_daily_outflow > 0.0
        && policy.minimum_buffer_pct <= policy.amber_buffer_pct
        && policy.amber_buffer_pct <= policy.target_buffer_pct
        && !policy.currency.trim().is_empty()
        && !policy.policy_version.trim().is_empty()
}

/// Evaluates a settlement-outflow surge scenario against an approved buffer
/// policy. `balance` is optional precisely because the absence of a reconciled
/// balance is a normal, expected state that must fail closed rather than be
/// substituted with an assumed figure.
pub fn evaluate_stress_test(
    policy: &BufferPolicy,
    scenario: &StressScenario,
    balance: Option<&ReconciledBalance>,
) -> StressTestOutcome {
    if !scenario.outflow_multiplier.is_finite() || scenario.outflow_multiplier < 1.0 {
        return StressTestOutcome::fail_closed(
            scenario,
            StressTestStatus::InputInconsistent,
            "The scenario outflow multiplier must be a finite value of at least 1.0.",
            "SCENARIO_MULTIPLIER_INVALID",
        );
    }

    if !policy_is_consistent(policy) {
        return StressTestOutcome::fail_closed(
            scenario,
            StressTestStatus::InputInconsistent,
            "The approved buffer policy is internally inconsistent, so no stressed threshold can be derived.",
            "BUFFER_POLICY_INCONSISTENT",
        );
    }

    let Some(balance) = balance else {
        return StressTestOutcome::fail_closed(
            scenario,
            StressTestStatus::InputUnavailable,
            "No reconciled balance observation is available from an authorised source, so the stress test cannot be computed.",
            "RECONCILED_BALANCE_UNAVAILABLE",
        );
    };

    if balance.source_reference.trim().is_empty() {
        return StressTestOutcome::fail_closed(
            scenario,
            StressTestStatus::InputInconsistent,
            "The reconciled balance carries no source reference, so its provenance cannot be evidenced.",
            "RECONCILED_BALANCE_UNSOURCED",
        );
    }

    if !balance.available_amount.is_finite() || balance.available_amount < 0.0 {
        return StressTestOutcome::fail_closed(
            scenario,
            StressTestStatus::InputInconsistent,
            "The reconciled balance is not a finite non-negative amount.",
            "RECONCILED_BALANCE_INVALID",
        );
    }

    if balance.age_hours > MAX_BALANCE_AGE_HOURS {
        return StressTestOutcome::fail_closed(
            scenario,
            StressTestStatus::InputStale,
            "The reconciled balance observation is older than the permitted staleness window.",
            "RECONCILED_BALANCE_STALE",
        );
    }

    let stressed_daily_outflow = policy.approved_daily_outflow * scenario.outflow_multiplier;
    let stressed_minimum_buffer = stressed_daily_outflow * policy.minimum_buffer_pct;
    let stressed_amber_buffer = stressed_daily_outflow * policy.amber_buffer_pct;
    let stressed_target_buffer = stressed_daily_outflow * policy.target_buffer_pct;

    let shortfall_to_target = (stressed_target_buffer - balance.available_amount).max(0.0);
    let recommendation_ceiling = stressed_target_buffer * policy.max_recommendation_pct_of_target;
    let computed_recommendation_amount = shortfall_to_target.min(recommendation_ceiling);
    let breaches_minimum_buffer = balance.available_amount < stressed_minimum_buffer;

    let mut reason_codes = Vec::new();
    if breaches_minimum_buffer {
        reason_codes.push("STRESSED_MINIMUM_BUFFER_BREACHED".to_string());
    } else if balance.available_amount < stressed_amber_buffer {
        reason_codes.push("STRESSED_AMBER_BUFFER_BREACHED".to_string());
    }
    if computed_recommendation_amount > 0.0 {
        reason_codes.push("REBALANCING_RECOMMENDATION_REQUIRED".to_string());
    }
    if computed_recommendation_amount >= recommendation_ceiling && shortfall_to_target > recommendation_ceiling {
        reason_codes.push("RECOMMENDATION_CAPPED_BY_POLICY".to_string());
    }

    StressTestOutcome {
        status: StressTestStatus::Completed,
        scenario_code: scenario.scenario_code.clone(),
        outflow_multiplier: scenario.outflow_multiplier,
        reconciled_available_balance: Some(balance.available_amount),
        stressed_daily_outflow: Some(stressed_daily_outflow),
        stressed_minimum_buffer: Some(stressed_minimum_buffer),
        stressed_amber_buffer: Some(stressed_amber_buffer),
        stressed_target_buffer: Some(stressed_target_buffer),
        computed_recommendation_amount: Some(computed_recommendation_amount),
        breaches_minimum_buffer: Some(breaches_minimum_buffer),
        limitation: None,
        reason_codes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zar_policy() -> BufferPolicy {
        BufferPolicy {
            corridor: Corridor::SouthAfricaZar,
            currency: "ZAR".to_string(),
            policy_version: "test-only-not-approved".to_string(),
            approved_daily_outflow: 1_000_000.0,
            minimum_buffer_pct: 0.25,
            amber_buffer_pct: 0.35,
            target_buffer_pct: 0.50,
            max_recommendation_pct_of_target: 0.40,
        }
    }

    fn surge() -> StressScenario {
        StressScenario {
            scenario_code: "ZAR_SETTLEMENT_OUTFLOW_SURGE_50PCT".to_string(),
            outflow_multiplier: 1.5,
        }
    }

    #[test]
    fn fails_closed_without_a_reconciled_balance() {
        let outcome = evaluate_stress_test(&zar_policy(), &surge(), None);
        assert_eq!(outcome.status, StressTestStatus::InputUnavailable);
        assert!(outcome.stressed_minimum_buffer.is_none());
        assert!(outcome.computed_recommendation_amount.is_none());
        assert_eq!(outcome.reason_codes, vec!["RECONCILED_BALANCE_UNAVAILABLE"]);
    }

    #[test]
    fn fails_closed_on_a_stale_balance() {
        let balance = ReconciledBalance {
            available_amount: 400_000.0,
            age_hours: MAX_BALANCE_AGE_HOURS + 1,
            source_reference: "custodian-statement-reference".to_string(),
        };
        let outcome = evaluate_stress_test(&zar_policy(), &surge(), Some(&balance));
        assert_eq!(outcome.status, StressTestStatus::InputStale);
        assert!(outcome.computed_recommendation_amount.is_none());
    }

    #[test]
    fn fails_closed_on_an_unsourced_balance() {
        let balance = ReconciledBalance {
            available_amount: 400_000.0,
            age_hours: 1,
            source_reference: "   ".to_string(),
        };
        let outcome = evaluate_stress_test(&zar_policy(), &surge(), Some(&balance));
        assert_eq!(outcome.status, StressTestStatus::InputInconsistent);
        assert_eq!(outcome.reason_codes, vec!["RECONCILED_BALANCE_UNSOURCED"]);
    }

    #[test]
    fn fails_closed_on_an_inconsistent_policy() {
        let mut policy = zar_policy();
        policy.minimum_buffer_pct = 0.60; // above the target buffer
        let balance = ReconciledBalance {
            available_amount: 400_000.0,
            age_hours: 1,
            source_reference: "custodian-statement-reference".to_string(),
        };
        let outcome = evaluate_stress_test(&policy, &surge(), Some(&balance));
        assert_eq!(outcome.status, StressTestStatus::InputInconsistent);
        assert_eq!(outcome.reason_codes, vec!["BUFFER_POLICY_INCONSISTENT"]);
    }

    #[test]
    fn rejects_a_multiplier_below_one() {
        let scenario = StressScenario {
            scenario_code: "INVALID".to_string(),
            outflow_multiplier: 0.9,
        };
        let outcome = evaluate_stress_test(&zar_policy(), &scenario, None);
        assert_eq!(outcome.status, StressTestStatus::InputInconsistent);
        assert_eq!(outcome.reason_codes, vec!["SCENARIO_MULTIPLIER_INVALID"]);
    }

    #[test]
    fn derives_stressed_thresholds_deterministically() {
        // 1,000,000 approved daily outflow with a 50 percent surge gives a
        // stressed outflow of 1,500,000; the derived thresholds follow directly
        // from the approved policy fractions.
        let balance = ReconciledBalance {
            available_amount: 300_000.0,
            age_hours: 2,
            source_reference: "custodian-statement-reference".to_string(),
        };
        let outcome = evaluate_stress_test(&zar_policy(), &surge(), Some(&balance));
        assert_eq!(outcome.status, StressTestStatus::Completed);
        assert_eq!(outcome.stressed_daily_outflow, Some(1_500_000.0));
        assert_eq!(outcome.stressed_minimum_buffer, Some(375_000.0));
        assert_eq!(outcome.stressed_amber_buffer, Some(525_000.0));
        assert_eq!(outcome.stressed_target_buffer, Some(750_000.0));
        assert_eq!(outcome.breaches_minimum_buffer, Some(true));
        // Shortfall to target is 450,000 but the policy caps a single
        // recommendation at 40 percent of the stressed target (300,000).
        assert_eq!(outcome.computed_recommendation_amount, Some(300_000.0));
        assert!(outcome.reason_codes.contains(&"STRESSED_MINIMUM_BUFFER_BREACHED".to_string()));
        assert!(outcome.reason_codes.contains(&"RECOMMENDATION_CAPPED_BY_POLICY".to_string()));
    }

    #[test]
    fn recommends_nothing_when_the_stressed_target_is_already_held() {
        let balance = ReconciledBalance {
            available_amount: 800_000.0,
            age_hours: 1,
            source_reference: "custodian-statement-reference".to_string(),
        };
        let outcome = evaluate_stress_test(&zar_policy(), &surge(), Some(&balance));
        assert_eq!(outcome.status, StressTestStatus::Completed);
        assert_eq!(outcome.computed_recommendation_amount, Some(0.0));
        assert_eq!(outcome.breaches_minimum_buffer, Some(false));
        assert!(outcome.reason_codes.is_empty());
    }

    #[test]
    fn never_returns_a_transfer_instruction() {
        // The outcome type carries thresholds and a bounded recommendation only.
        // Serialising it must not produce any execution or settlement field.
        let balance = ReconciledBalance {
            available_amount: 300_000.0,
            age_hours: 2,
            source_reference: "custodian-statement-reference".to_string(),
        };
        let outcome = evaluate_stress_test(&zar_policy(), &surge(), Some(&balance));
        let encoded = serde_json::to_string(&outcome).expect("outcome serialises");
        for forbidden in ["execute", "transfer", "settle", "instruction"] {
            assert!(!encoded.contains(forbidden), "outcome must not imply execution: {forbidden}");
        }
    }
}
