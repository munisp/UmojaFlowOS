use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use risk_compliance_core::{evaluate, PolicyInput, PolicyResult};
use std::sync::Arc;

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

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/healthz", get(health))
        .route("/v1/policy/evaluate", post(evaluate_policy))
        .with_state(Arc::new(ServiceState));
    let port = std::env::var("PORT").unwrap_or_else(|_| "8082".to_string());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .expect("bind risk-compliance-core listener");
    axum::serve(listener, app)
        .await
        .expect("serve risk-compliance-core");
}
