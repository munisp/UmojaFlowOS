use crate::{Decision, PolicyResult};
use serde::{Deserialize, Serialize};

pub const POLICY_DECISION_EVENT_V1: &str = "umojaflowos.policy.decision.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyDecisionEvent {
    pub event_id: String,
    pub correlation_id: String,
    pub event_type: String,
    pub schema_version: String,
    pub decision: String,
    pub reason_codes: Vec<String>,
    pub external_execution_authorized: bool,
}

pub fn policy_event(
    event_id: String,
    correlation_id: String,
    result: PolicyResult,
) -> Result<PolicyDecisionEvent, &'static str> {
    if event_id.trim().is_empty() || correlation_id.trim().is_empty() {
        return Err("event identity is required");
    }
    let decision = match result.decision {
        Decision::Allow => "ALLOW",
        Decision::ManualReview => "MANUAL_REVIEW",
        Decision::Block => "BLOCK",
    };
    Ok(PolicyDecisionEvent {
        event_id,
        correlation_id,
        event_type: POLICY_DECISION_EVENT_V1.into(),
        schema_version: "v1".into(),
        decision: decision.into(),
        reason_codes: result.reason_codes,
        external_execution_authorized: false,
    })
}
