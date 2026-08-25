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
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use risk_compliance_core::{
    counterparty_risk::{assess_counterparty_risk, CounterpartyRiskInput},
    evaluate,
    monitoring::{evaluate_monitoring, MonitoringInput, MonitoringResult, RuleFinding},
    screening::{ScreeningGateway, ScreeningRequest, ScreeningResult},
    Decision, PolicyInput, PolicyResult, ScreeningState,
};
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// Service identity carried on every envelope. Must match the value the control
/// plane's contract pins with `z.literal`.
const SERVICE_NAME: &str = "umojaflowos-risk-compliance-core";
const CONTRACT_VERSION: &str = "v1";

/// Counters the service observes while running.
///
/// Each is incremented where the corresponding evaluation completes, so the
/// values are measurements rather than estimates. Nothing here is derived,
/// smoothed, or back-filled: a counter this service cannot observe is not
/// reported at all, because a fabricated zero reads as "healthy" and would be
/// worse than an absent field.
struct ServiceState {
    started_at: Instant,
    policy_evaluations: AtomicU64,
    monitoring_evaluations: AtomicU64,
    monitoring_review_required: AtomicU64,
    counterparty_assessments: AtomicU64,
    counterparty_review_required: AtomicU64,
    screening_evaluations: AtomicU64,
    screening_unavailable: AtomicU64,
    screening_gateway: Option<ScreeningGateway>,
}

impl ServiceState {
    fn new(screening_gateway: Option<ScreeningGateway>) -> Self {
        Self {
            started_at: Instant::now(),
            policy_evaluations: AtomicU64::new(0),
            monitoring_evaluations: AtomicU64::new(0),
            monitoring_review_required: AtomicU64::new(0),
            counterparty_assessments: AtomicU64::new(0),
            counterparty_review_required: AtomicU64::new(0),
            screening_evaluations: AtomicU64::new(0),
            screening_unavailable: AtomicU64::new(0),
            screening_gateway,
        }
    }

    fn screening_provider(&self) -> &'static str {
        if self.screening_gateway.is_some() {
            "configured_screening_gateway"
        } else {
            "disabled_without_verified_provider"
        }
    }
}

#[derive(Debug, Serialize)]
struct MetricsSnapshot {
    service: &'static str,
    language: &'static str,
    uptime_seconds: u64,
    policy_evaluations: u64,
    monitoring_evaluations: u64,
    monitoring_review_required: u64,
    counterparty_assessments: u64,
    counterparty_review_required: u64,
    screening_evaluations: u64,
    screening_unavailable: u64,
    observed_at: String,
    screening_provider: &'static str,
}

/// RFC3339 observation time so the console can show how old a reading is.
fn observed_at_now() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    // Formatted from epoch seconds without pulling in a date library, since the
    // control plane only needs a parseable instant.
    let secs = elapsed.as_secs() as i64;
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Days-since-epoch to a civil date, using Howard Hinnant's algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

async fn health(State(state): State<Arc<ServiceState>>) -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"service":"risk-compliance-core","status":"healthy","screening_provider":state.screening_provider()}),
    )
}

async fn metrics(State(state): State<Arc<ServiceState>>) -> Json<MetricsSnapshot> {
    Json(MetricsSnapshot {
        service: "risk-compliance-core",
        language: "rust",
        uptime_seconds: state.started_at.elapsed().as_secs(),
        policy_evaluations: state.policy_evaluations.load(Ordering::Relaxed),
        monitoring_evaluations: state.monitoring_evaluations.load(Ordering::Relaxed),
        monitoring_review_required: state.monitoring_review_required.load(Ordering::Relaxed),
        counterparty_assessments: state.counterparty_assessments.load(Ordering::Relaxed),
        counterparty_review_required: state.counterparty_review_required.load(Ordering::Relaxed),
        screening_evaluations: state.screening_evaluations.load(Ordering::Relaxed),
        screening_unavailable: state.screening_unavailable.load(Ordering::Relaxed),
        observed_at: observed_at_now(),
        screening_provider: state.screening_provider(),
    })
}

async fn evaluate_policy(
    State(state): State<Arc<ServiceState>>,
    Json(input): Json<PolicyInput>,
) -> Json<PolicyResult> {
    state.policy_evaluations.fetch_add(1, Ordering::Relaxed);
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
    State(state): State<Arc<ServiceState>>,
    Json(input): Json<MonitoringInput>,
) -> Json<MonitoringEnvelope> {
    let result = evaluate_monitoring(&input);
    state.monitoring_evaluations.fetch_add(1, Ordering::Relaxed);
    // Counted separately because "how many evaluations happened" and "how many
    // needed a human" answer different operational questions.
    if !matches!(result.decision, Decision::Allow) {
        state
            .monitoring_review_required
            .fetch_add(1, Ordering::Relaxed);
    }
    Json(MonitoringEnvelope::from_result(result))
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
    State(state): State<Arc<ServiceState>>,
    Json(input): Json<CounterpartyRiskInput>,
) -> Json<CounterpartyEnvelope> {
    let assessment = assess_counterparty_risk(&input);
    state
        .counterparty_assessments
        .fetch_add(1, Ordering::Relaxed);
    if assessment.review_required {
        state
            .counterparty_review_required
            .fetch_add(1, Ordering::Relaxed);
    }
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

#[derive(Debug, Serialize)]
struct ScreeningEnvelope {
    service: &'static str,
    contract_version: &'static str,
    envelope_type: &'static str,
    state: ScreeningState,
    provider_reference: String,
    source_version: String,
    evidence_sha256: String,
    screened_at: String,
}

impl ScreeningEnvelope {
    fn from_result(result: ScreeningResult) -> Self {
        Self {
            service: SERVICE_NAME,
            contract_version: CONTRACT_VERSION,
            envelope_type: "umojaflowos.risk.screening_result.v1",
            state: result.state,
            provider_reference: result.provider_reference,
            source_version: result.source_version,
            evidence_sha256: result.evidence_sha256,
            screened_at: result.screened_at,
        }
    }
}

async fn screen_subject(
    State(state): State<Arc<ServiceState>>,
    Json(input): Json<ScreeningRequest>,
) -> Result<Json<ScreeningEnvelope>, (StatusCode, String)> {
    state.screening_evaluations.fetch_add(1, Ordering::Relaxed);
    let gateway = match state.screening_gateway.as_ref() {
        Some(gateway) => gateway,
        None => {
            state.screening_unavailable.fetch_add(1, Ordering::Relaxed);
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "screening provider is not configured".to_string(),
            ));
        }
    };
    match gateway.screen(input).await {
        Ok(result) => Ok(Json(ScreeningEnvelope::from_result(result))),
        Err(error) => {
            state.screening_unavailable.fetch_add(1, Ordering::Relaxed);
            Err((StatusCode::SERVICE_UNAVAILABLE, error))
        }
    }
}

fn router_with_screening(screening_gateway: Option<ScreeningGateway>) -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/metrics", get(metrics))
        .route("/v1/policy/evaluate", post(evaluate_policy))
        .route("/v1/monitoring/evaluate", post(evaluate_monitoring_route))
        .route("/v1/counterparty/assess", post(assess_counterparty_route))
        .route("/v1/screening/check", post(screen_subject))
        .with_state(Arc::new(ServiceState::new(screening_gateway)))
}

fn router() -> Router {
    router_with_screening(None)
}

#[tokio::main]
async fn main() {
    let screening_gateway = ScreeningGateway::from_environment()
        .expect("construct fail-closed screening gateway from deployment environment");
    let port = std::env::var("PORT").unwrap_or_else(|_| "8082".to_string());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .expect("bind risk-compliance-core listener");
    let app = match screening_gateway {
        Some(gateway) => router_with_screening(Some(gateway)),
        None => router(),
    };
    axum::serve(listener, app)
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

    /// Metrics must be measurements. An endpoint returning plausible constants
    /// would satisfy a shape check, so these drive real requests through the
    /// router and then require the counters to match exactly that traffic.
    async fn read_metrics(app: &mut Router) -> serde_json::Value {
        use axum::body::{to_bytes, Body};
        use axum::http::Request;
        use tower::ServiceExt;

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/v1/metrics")
                    .body(Body::empty())
                    .expect("build metrics request"),
            )
            .await
            .expect("metrics route responds");
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("read metrics body");
        serde_json::from_slice(&body).expect("metrics body is JSON")
    }

    async fn post_monitoring(app: &mut Router, payload: serde_json::Value) {
        use axum::body::Body;
        use axum::http::Request;
        use tower::ServiceExt;

        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/v1/monitoring/evaluate")
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))
                    .expect("build monitoring request"),
            )
            .await
            .expect("monitoring route responds");
    }

    #[tokio::test]
    async fn metrics_start_at_zero_and_identify_the_service() {
        let mut app = router();
        let metrics = read_metrics(&mut app).await;
        assert_eq!(metrics["service"], "risk-compliance-core");
        assert_eq!(metrics["language"], "rust");
        assert_eq!(metrics["monitoring_evaluations"], 0);
        assert_eq!(metrics["counterparty_assessments"], 0);
        // An observation time is required so the console can show staleness.
        assert!(metrics["observed_at"]
            .as_str()
            .is_some_and(|s| s.ends_with('Z')));
    }

    #[tokio::test]
    async fn metrics_count_the_requests_actually_served() {
        let mut app = router();
        for _ in 0..3 {
            post_monitoring(&mut app, serde_json::json!({"corridor":"NIGERIA_NGN"})).await;
        }
        let metrics = read_metrics(&mut app).await;
        assert_eq!(metrics["monitoring_evaluations"], 3);
        // Each of those evaluations blocks for missing input, so all three are
        // also counted as requiring review. This distinguishes the two counters.
        assert_eq!(metrics["monitoring_review_required"], 3);
    }

    #[tokio::test]
    async fn metrics_restate_that_screening_is_disabled() {
        let mut app = router();
        let metrics = read_metrics(&mut app).await;
        assert_eq!(
            metrics["screening_provider"],
            "disabled_without_verified_provider"
        );
    }

    /// The date arithmetic backing `observed_at` is hand-written, so it is
    /// checked against known values rather than trusted.
    #[test]
    fn civil_date_conversion_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        // A leap day, which is where naive implementations drift.
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    }
}
