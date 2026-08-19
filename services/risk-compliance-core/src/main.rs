//! HTTP interface for the Rust risk and compliance core.
//!
//! Every route is an evaluation. None of them settles a payment, files a
//! report, or opens a provider integration: the service returns findings and
//! bands, and disposition remains a human decision recorded in the control
//! plane. Responses are emitted as versioned envelopes that carry the emitting
//! service and contract version, because the TypeScript control plane parses
//! them with strict schemas and rejects anything it does not recognise.

use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use risk_compliance_core::{
    counterparty_risk::{assess_counterparty_risk, CounterpartyRiskInput},
    evaluate,
    monitoring::{evaluate_monitoring, MonitoringInput, MonitoringResult, RuleFinding},
    Decision, PolicyInput, PolicyResult,
};
use serde::Serialize;
use std::sync::Arc;

/// Service identity carried on every envelope. Must match the value the control
/// plane's contract pins with `z.literal`.
const SERVICE_NAME: &str = "umojaflowos-risk-compliance-core";
const CONTRACT_VERSION: &str = "v1";

#[derive(Clone)]
struct ServiceState;

async fn health() -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"service":"risk-compliance-core","status":"healthy","screening_provider":"disabled_without_verified_provider"}),
    )
}

async fn evaluate_policy(
    State(_state): State<Arc<ServiceState>>,
    Json(input): Json<PolicyInput>,
) -> Json<PolicyResult> {
    Json(evaluate(&input))
}

/// Serialised form of a monitoring decision. The control plane's enum is
/// `ALLOW | MANUAL_REVIEW | BLOCK`, so the wire value is spelled explicitly here
/// rather than relying on an incidental derive.
fn decision_wire_value(decision: Decision) -> &'static str {
    match decision {
        Decision::Allow => "ALLOW",
        Decision::ManualReview => "MANUAL_REVIEW",
        Decision::Block => "BLOCK",
    }
}

#[derive(Debug, Serialize)]
struct MonitoringEnvelope {
    service: &'static str,
    contract_version: &'static str,
    envelope_type: &'static str,
    decision: &'static str,
    findings: Vec<RuleFinding>,
}

impl MonitoringEnvelope {
    fn from_result(result: MonitoringResult) -> Self {
        Self {
            service: SERVICE_NAME,
            contract_version: CONTRACT_VERSION,
            envelope_type: "umojaflowos.risk.monitoring_result.v1",
            decision: decision_wire_value(result.decision),
            findings: result.findings,
        }
    }
}

async fn evaluate_monitoring_route(
    State(_state): State<Arc<ServiceState>>,
    Json(input): Json<MonitoringInput>,
) -> Json<MonitoringEnvelope> {
    Json(MonitoringEnvelope::from_result(evaluate_monitoring(&input)))
}

#[derive(Debug, Serialize)]
struct CounterpartyEnvelope {
    service: &'static str,
    contract_version: &'static str,
    envelope_type: &'static str,
    band: String,
    reason_codes: Vec<String>,
    review_required: bool,
}

async fn assess_counterparty_route(
    State(_state): State<Arc<ServiceState>>,
    Json(input): Json<CounterpartyRiskInput>,
) -> Json<CounterpartyEnvelope> {
    let assessment = assess_counterparty_risk(&input);
    // `RiskBand` already serialises in SCREAMING_SNAKE_CASE; going through serde
    // rather than a hand-written match keeps the wire value tied to the enum.
    let band = serde_json::to_value(assessment.band)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "UNDETERMINED".to_string());
    Json(CounterpartyEnvelope {
        service: SERVICE_NAME,
        contract_version: CONTRACT_VERSION,
        envelope_type: "umojaflowos.risk.counterparty_assessment.v1",
        band,
        reason_codes: assessment.reason_codes,
        review_required: assessment.review_required,
    })
}

fn router() -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/policy/evaluate", post(evaluate_policy))
        .route("/v1/monitoring/evaluate", post(evaluate_monitoring_route))
        .route("/v1/counterparty/assess", post(assess_counterparty_route))
        .with_state(Arc::new(ServiceState))
}

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8082".to_string());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .expect("bind risk-compliance-core listener");
    axum::serve(listener, router())
        .await
        .expect("serve risk-compliance-core");
}

#[cfg(test)]
mod tests {
    use super::*;
    use risk_compliance_core::monitoring::MonitoringInput;
    use risk_compliance_core::Corridor;

    /// The control plane pins these three strings with `z.literal`, so a change
    /// here is a breaking contract change and must fail this test first.
    #[test]
    fn monitoring_envelope_matches_the_published_contract_identity() {
        let envelope = MonitoringEnvelope::from_result(evaluate_monitoring(&MonitoringInput {
            corridor: Corridor::NigeriaNgn,
            amount_minor_units: None,
            reporting_threshold_minor_units: None,
            customer_transactions_in_window: None,
            max_transactions_per_window: None,
            customer_value_in_window_minor_units: None,
            max_value_per_window_minor_units: None,
            counterparty_licence_verified: None,
            beneficiary_jurisdiction_expected: None,
        }));
        assert_eq!(envelope.service, "umojaflowos-risk-compliance-core");
        assert_eq!(envelope.contract_version, "v1");
        assert_eq!(
            envelope.envelope_type,
            "umojaflowos.risk.monitoring_result.v1"
        );
    }

    /// Wholly missing inputs must serialise as BLOCK, never as ALLOW. The
    /// control plane rejects an ALLOW that carries INPUT_UNAVAILABLE findings,
    /// so emitting one would take the service offline rather than pass through.
    #[test]
    fn absent_monitoring_inputs_serialise_as_block_with_unavailable_reasons() {
        let envelope = MonitoringEnvelope::from_result(evaluate_monitoring(&MonitoringInput {
            corridor: Corridor::SouthAfricaZar,
            amount_minor_units: None,
            reporting_threshold_minor_units: None,
            customer_transactions_in_window: None,
            max_transactions_per_window: None,
            customer_value_in_window_minor_units: None,
            max_value_per_window_minor_units: None,
            counterparty_licence_verified: None,
            beneficiary_jurisdiction_expected: None,
        }));
        assert_eq!(envelope.decision, "BLOCK");
        assert!(envelope
            .findings
            .iter()
            .any(|finding| finding.reason_code.starts_with("INPUT_UNAVAILABLE")));
    }

    /// Serialised JSON must contain no execution-shaped or credential-shaped
    /// key. The control plane walks every payload and refuses such keys at any
    /// depth, so this asserts the same property at the producing end.
    #[test]
    fn serialised_envelopes_carry_no_execution_or_credential_keys() {
        let monitoring = serde_json::to_string(&MonitoringEnvelope::from_result(
            evaluate_monitoring(&MonitoringInput {
                corridor: Corridor::KenyaKes,
                amount_minor_units: Some(10),
                reporting_threshold_minor_units: Some(100),
                customer_transactions_in_window: Some(1),
                max_transactions_per_window: Some(5),
                customer_value_in_window_minor_units: Some(10),
                max_value_per_window_minor_units: Some(1_000),
                counterparty_licence_verified: Some(true),
                beneficiary_jurisdiction_expected: Some(true),
            }),
        ))
        .expect("serialise monitoring envelope");
        for forbidden in [
            "\"execute\"",
            "\"settle\"",
            "\"submit\"",
            "\"transfer\"",
            "\"credential\"",
            "\"api_key\"",
        ] {
            assert!(
                !monitoring.contains(forbidden),
                "monitoring envelope must not contain {forbidden}"
            );
        }
    }

    /// Every route the control-plane bridge calls must exist. A bridge pointing
    /// at a missing route degrades to `unavailable`, which is safe but silently
    /// disables monitoring, so the route set is asserted explicitly.
    #[tokio::test]
    async fn every_bridge_route_is_registered_and_answers() {
        use axum::body::{to_bytes, Body};
        use axum::http::{Request, StatusCode};
        use tower::ServiceExt;

        let app = router();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/counterparty/assess")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .expect("build counterparty request"),
            )
            .await
            .expect("counterparty route responds");
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("read counterparty body");
        let parsed: serde_json::Value =
            serde_json::from_slice(&body).expect("counterparty body is JSON");
        // No evidence was supplied, so the band must be undetermined and review
        // must be demanded; a favourable band here would be a fabrication.
        assert_eq!(parsed["band"], "UNDETERMINED");
        assert_eq!(parsed["review_required"], true);
        assert_eq!(
            parsed["envelope_type"],
            "umojaflowos.risk.counterparty_assessment.v1"
        );

        let app = router();
        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/monitoring/evaluate")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({"corridor":"NIGERIA_NGN"}).to_string(),
                    ))
                    .expect("build monitoring request"),
            )
            .await
            .expect("monitoring route responds");
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("read monitoring body");
        let parsed: serde_json::Value =
            serde_json::from_slice(&body).expect("monitoring body is JSON");
        assert_eq!(parsed["decision"], "BLOCK");
    }
}
