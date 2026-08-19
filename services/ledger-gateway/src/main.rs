//! HTTP interface for the Rust ledger gateway.
//!
//! The gateway is a **verifier, not a poster**. It answers two questions and
//! nothing else: does a proposed double-entry posting set balance per currency,
//! and does a confirmed TigerBeetle transfer fact agree with its PostgreSQL
//! projection? It never writes to TigerBeetle, never writes to PostgreSQL, and
//! holds no database client of any kind — see the crate manifest, which depends
//! only on axum, serde and tokio. Actually posting to TigerBeetle stays
//! activation-gated behind the cluster configuration under `infra/tigerbeetle/`.
//!
//! Responses are the versioned envelopes the TypeScript control plane parses
//! with strict schemas. That parser independently re-derives the per-currency
//! net and re-checks the fact-to-projection comparison, so this service is not
//! trusted on either claim; agreement between the two implementations is the
//! actual control.

use axum::{
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use ledger_gateway::{
    eventing::{validate_payment_event, EventEnvelope},
    validate_balanced, verify_projection, ConfirmedTransferFact, LedgerError,
    PostgresProjectionRecord, Posting, ReconciliationError,
};
use serde::{Deserialize, Serialize};

const SERVICE_NAME: &str = "umojaflowos-ledger-gateway";
const CONTRACT_VERSION: &str = "v1";

async fn health() -> Json<serde_json::Value> {
    Json(
        serde_json::json!({"service":"ledger-gateway","status":"healthy","ledger_backend":"disabled_without_deployed_tigerbeetle"}),
    )
}

#[derive(Debug, Serialize)]
struct Imbalance {
    currency: String,
    net_minor: i128,
}

#[derive(Debug, Serialize)]
struct PostingValidationEnvelope {
    service: &'static str,
    contract_version: &'static str,
    envelope_type: &'static str,
    postings: Vec<Posting>,
    balanced: bool,
    imbalance: Option<Imbalance>,
}

/// Validate a posting set.
///
/// A structurally invalid set (empty, missing account or currency, negative
/// amount) is refused with 422: it is not an imbalance but a malformed request,
/// and returning a "balanced: false" envelope for it would misrepresent the
/// defect. An imbalance, by contrast, is a real and reportable finding.
async fn validate_postings(
    Json(postings): Json<Vec<Posting>>,
) -> Result<Json<PostingValidationEnvelope>, (StatusCode, Json<serde_json::Value>)> {
    let imbalance = match validate_balanced(&postings) {
        Ok(()) => None,
        Err(LedgerError::Unbalanced {
            currency,
            net_minor,
        }) => Some(Imbalance {
            currency,
            net_minor,
        }),
        Err(error) => {
            return Err((
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(serde_json::json!({"error": format!("{error:?}")})),
            ))
        }
    };
    Ok(Json(PostingValidationEnvelope {
        service: SERVICE_NAME,
        contract_version: CONTRACT_VERSION,
        envelope_type: "umojaflowos.ledger.posting_validation.v1",
        postings,
        balanced: imbalance.is_none(),
        imbalance,
    }))
}

#[derive(Debug, Deserialize)]
struct ReconciliationRequest {
    confirmed_fact: ConfirmedTransferFact,
    projection: PostgresProjectionRecord,
}

#[derive(Debug, Serialize)]
struct ContractFact {
    transfer_id: u64,
    correlation_id: String,
    currency: String,
    amount_minor: u64,
    posted_at: String,
}

#[derive(Debug, Serialize)]
struct ContractProjection {
    transfer_id: u64,
    correlation_id: String,
    currency: String,
    amount_minor: u64,
    projected_at: String,
}

#[derive(Debug, Serialize)]
struct ReconciliationEnvelope {
    service: &'static str,
    contract_version: &'static str,
    envelope_type: &'static str,
    confirmed_fact: ContractFact,
    projection: ContractProjection,
    reconciled: bool,
    discrepancy_reason: Option<&'static str>,
}

/// Reconcile a confirmed TigerBeetle transfer fact against its PostgreSQL
/// projection. Incomplete evidence on either side is a discrepancy, never a
/// silent pass: a missing projection cannot be read as agreement.
async fn reconcile_projection(
    Json(request): Json<ReconciliationRequest>,
) -> Json<ReconciliationEnvelope> {
    let outcome = verify_projection(&request.confirmed_fact, &request.projection);
    let discrepancy_reason = match outcome {
        Ok(()) => None,
        Err(ReconciliationError::IncompleteConfirmedFact) => Some("INCOMPLETE_CONFIRMED_FACT"),
        Err(ReconciliationError::IncompleteProjection) => Some("INCOMPLETE_PROJECTION"),
        Err(ReconciliationError::Mismatch) => Some("MISMATCH"),
    };
    Json(ReconciliationEnvelope {
        service: SERVICE_NAME,
        contract_version: CONTRACT_VERSION,
        envelope_type: "umojaflowos.ledger.projection_reconciliation.v1",
        confirmed_fact: ContractFact {
            transfer_id: request.confirmed_fact.transfer_id,
            correlation_id: request.confirmed_fact.correlation_id.clone(),
            currency: request.confirmed_fact.currency.clone(),
            amount_minor: request.confirmed_fact.amount_minor,
            posted_at: request.confirmed_fact.posted_at_rfc3339.clone(),
        },
        projection: ContractProjection {
            transfer_id: request.projection.transfer_id,
            correlation_id: request.projection.correlation_id.clone(),
            currency: request.projection.currency.clone(),
            amount_minor: request.projection.amount_minor,
            projected_at: request.projection.projected_at_rfc3339.clone(),
        },
        reconciled: discrepancy_reason.is_none(),
        discrepancy_reason,
    })
}

async fn receive_payment_event(
    Json(event): Json<EventEnvelope>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<serde_json::Value>)> {
    validate_payment_event(&event).map_err(|error| {
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({"error": format!("{error:?}"), "ledger_projection":"not_started"})),
        )
    })?;
    Ok(Json(serde_json::json!({
        "accepted": true,
        "event_id": event.event_id,
        "ledger_projection": "disabled_without_deployed_tigerbeetle"
    })))
}

fn router() -> Router {
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/postings/validate", post(validate_postings))
        .route("/v1/projections/reconcile", post(reconcile_projection))
        .route(
            "/events/payment-order-validated",
            post(receive_payment_event),
        )
}

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "8083".to_string());
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{port}"))
        .await
        .expect("bind ledger-gateway listener");
    axum::serve(listener, router())
        .await
        .expect("serve ledger-gateway");
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::ServiceExt;

    async fn post_json(uri: &str, body: serde_json::Value) -> (StatusCode, serde_json::Value) {
        let response = router()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .expect("build request"),
            )
            .await
            .expect("route responds");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 256 * 1024)
            .await
            .expect("read body");
        let parsed = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, parsed)
    }

    #[tokio::test]
    async fn balanced_postings_return_the_published_envelope_with_no_imbalance() {
        let (status, body) = post_json(
            "/v1/postings/validate",
            serde_json::json!([
                {"account_id":"nostro-ngn","currency":"NGN","debit_minor":100000,"credit_minor":0},
                {"account_id":"customer-ngn","currency":"NGN","debit_minor":0,"credit_minor":100000}
            ]),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["service"], SERVICE_NAME);
        assert_eq!(body["contract_version"], CONTRACT_VERSION);
        assert_eq!(
            body["envelope_type"],
            "umojaflowos.ledger.posting_validation.v1"
        );
        assert_eq!(body["balanced"], true);
        assert!(body["imbalance"].is_null());
        // The envelope carries the postings it judged, so the control plane can
        // re-derive the net independently instead of trusting the flag.
        assert_eq!(body["postings"].as_array().map(Vec::len), Some(2));
    }

    #[tokio::test]
    async fn an_imbalance_is_reported_with_its_currency_and_net() {
        let (status, body) = post_json(
            "/v1/postings/validate",
            serde_json::json!([
                {"account_id":"nostro-kes","currency":"KES","debit_minor":100000,"credit_minor":0},
                {"account_id":"customer-kes","currency":"KES","debit_minor":0,"credit_minor":90000}
            ]),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["balanced"], false);
        assert_eq!(body["imbalance"]["currency"], "KES");
        assert_eq!(body["imbalance"]["net_minor"], 10000);
    }

    #[tokio::test]
    async fn a_malformed_posting_set_is_refused_rather_than_reported_as_unbalanced() {
        // A negative amount is not an imbalance; reporting it as one would
        // misrepresent a malformed request as a ledger finding.
        let (status, _) = post_json(
            "/v1/postings/validate",
            serde_json::json!([
                {"account_id":"nostro-zar","currency":"ZAR","debit_minor":-1,"credit_minor":0}
            ]),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn an_agreeing_projection_reconciles_with_no_discrepancy() {
        let (status, body) = post_json(
            "/v1/projections/reconcile",
            serde_json::json!({
                "confirmed_fact":{"transfer_id":42,"correlation_id":"corr-42","currency":"ZAR","amount_minor":250000,"posted_at_rfc3339":"2026-08-18T10:00:00+00:00"},
                "projection":{"transfer_id":42,"correlation_id":"corr-42","currency":"ZAR","amount_minor":250000,"projected_at_rfc3339":"2026-08-18T10:00:01+00:00"}
            }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["envelope_type"],
            "umojaflowos.ledger.projection_reconciliation.v1"
        );
        assert_eq!(body["reconciled"], true);
        assert!(body["discrepancy_reason"].is_null());
    }

    #[tokio::test]
    async fn a_differing_amount_is_reported_as_a_mismatch_not_an_agreement() {
        let (_, body) = post_json(
            "/v1/projections/reconcile",
            serde_json::json!({
                "confirmed_fact":{"transfer_id":42,"correlation_id":"corr-42","currency":"ZAR","amount_minor":250000,"posted_at_rfc3339":"2026-08-18T10:00:00+00:00"},
                "projection":{"transfer_id":42,"correlation_id":"corr-42","currency":"ZAR","amount_minor":249999,"projected_at_rfc3339":"2026-08-18T10:00:01+00:00"}
            }),
        )
        .await;
        assert_eq!(body["reconciled"], false);
        assert_eq!(body["discrepancy_reason"], "MISMATCH");
    }

    #[tokio::test]
    async fn a_missing_projection_is_a_discrepancy_rather_than_a_silent_pass() {
        let (_, body) = post_json(
            "/v1/projections/reconcile",
            serde_json::json!({
                "confirmed_fact":{"transfer_id":42,"correlation_id":"corr-42","currency":"ZAR","amount_minor":250000,"posted_at_rfc3339":"2026-08-18T10:00:00+00:00"},
                "projection":{"transfer_id":0,"correlation_id":"","currency":"","amount_minor":0,"projected_at_rfc3339":""}
            }),
        )
        .await;
        assert_eq!(body["reconciled"], false);
        assert_eq!(body["discrepancy_reason"], "INCOMPLETE_PROJECTION");
    }

    #[tokio::test]
    async fn no_route_reports_a_live_tigerbeetle_backend() {
        let response = router()
            .oneshot(
                Request::builder()
                    .uri("/healthz")
                    .body(Body::empty())
                    .expect("build health request"),
            )
            .await
            .expect("health responds");
        let bytes = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("read health body");
        let body: serde_json::Value = serde_json::from_slice(&bytes).expect("health body is JSON");
        // The gateway must never imply a deployed ledger cluster it does not have.
        assert_eq!(
            body["ledger_backend"],
            "disabled_without_deployed_tigerbeetle"
        );
    }
}
