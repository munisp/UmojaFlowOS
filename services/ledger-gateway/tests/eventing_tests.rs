use ledger_gateway::eventing::{
    validate_payment_event, EventEnvelope, EventError, PAYMENT_ORDER_VALIDATED_V1,
};

#[test]
fn rejects_event_without_traceability() {
    let event = EventEnvelope {
        event_id: "".into(),
        event_type: PAYMENT_ORDER_VALIDATED_V1.into(),
        schema_version: "v1".into(),
        occurred_at_rfc3339: "2026-08-18T00:00:00Z".into(),
        correlation_id: "order-1".into(),
        payload: serde_json::json!({}),
    };
    assert_eq!(
        validate_payment_event(&event),
        Err(EventError::MissingIdentity)
    );
}
