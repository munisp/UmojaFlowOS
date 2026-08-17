use axum::{
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use ledger_gateway::{validate_balanced, Posting};

async fn health() -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"service":"ledger-gateway","status":"healthy","ledger_backend":"disabled_without_deployed_tigerbeetle"}),
    )
}

async fn validate_postings(
    Json(postings): Json<Vec<Posting>>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_balanced(&postings).map_err(|error| {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({"error": format!("{error:?}")})),
        )
    })?;
    Ok(Json(
        serde_json::json!({"valid":true,"ledger_backend":"disabled_without_deployed_tigerbeetle"}),
    ))
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/healthz", get(health))
        .route("/v1/postings/validate", post(validate_postings));
    let port = std::env::var("PORT").unwrap_or_else(|_| "8083".to_string());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .expect("bind ledger-gateway listener");
    axum::serve(listener, app)
        .await
        .expect("serve ledger-gateway");
}
