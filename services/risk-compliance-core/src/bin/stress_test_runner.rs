//! Executes a settlement-outflow surge stress test against real configured
//! inputs and prints an evidence record.
//!
//! The runner reads a JSON document describing the approved buffer policy, the
//! scenario, and (optionally) a reconciled balance observation. It never
//! synthesises inputs: if the document omits a reconciled balance, or the
//! balance is stale or unsourced, the run fails closed and the printed evidence
//! records exactly that outcome. This is the intended behaviour when no
//! authorised balance source is connected.
//!
//! Usage:
//!   stress-test-runner <path-to-inputs.json>

use std::{env, fs, process};

use risk_compliance_core::treasury_stress::{
    evaluate_stress_test, BufferPolicy, ReconciledBalance, StressScenario, StressTestStatus,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct RunnerInputs {
    buffer_policy: BufferPolicy,
    scenario: StressScenario,
    #[serde(default)]
    reconciled_balance: Option<ReconciledBalance>,
}

fn main() {
    let Some(path) = env::args().nth(1) else {
        eprintln!("usage: stress-test-runner <path-to-inputs.json>");
        process::exit(2);
    };

    let raw = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) => {
            eprintln!("unable to read {path}: {error}");
            process::exit(2);
        }
    };

    let inputs: RunnerInputs = match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("inputs are not a valid stress-test document: {error}");
            process::exit(2);
        }
    };

    let outcome = evaluate_stress_test(
        &inputs.buffer_policy,
        &inputs.scenario,
        inputs.reconciled_balance.as_ref(),
    );

    let evidence = serde_json::json!({
        "service": "risk-compliance-core",
        "evaluation": "treasury_settlement_outflow_surge",
        "inputs_document": path,
        "corridor": inputs.buffer_policy.corridor,
        "currency": inputs.buffer_policy.currency,
        "policy_version": inputs.buffer_policy.policy_version,
        "outcome": outcome,
        "authorises_execution": false,
    });

    println!(
        "{}",
        serde_json::to_string_pretty(&evidence).expect("evidence serialises")
    );

    // A fail-closed classification is a valid, expected result, but it is not a
    // completed computation, so the exit status distinguishes the two.
    if outcome.status != StressTestStatus::Completed {
        process::exit(3);
    }
}
