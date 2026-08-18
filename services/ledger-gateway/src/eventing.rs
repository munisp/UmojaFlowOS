use serde::{Deserialize, Serialize};

pub const PAYMENT_ORDER_VALIDATED_V1: &str = "umojaflowos.payment.order.validated.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventEnvelope {
    pub event_id: String,
    pub event_type: String,
    pub schema_version: String,
    pub occurred_at_rfc3339: String,
    pub correlation_id: String,
    pub payload: serde_json::Value,
}

pub trait EventConsumer {
    fn consume(&self, topic: &str, event: &EventEnvelope) -> Result<(), EventError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventError {
    MissingIdentity,
    UnsupportedType,
    TransportDisabled,
}

pub fn validate_payment_event(event: &EventEnvelope) -> Result<(), EventError> {
    if event.event_id.trim().is_empty() || event.correlation_id.trim().is_empty() {
        return Err(EventError::MissingIdentity);
    }
    if event.event_type != PAYMENT_ORDER_VALIDATED_V1 || event.schema_version != "v1" {
        return Err(EventError::UnsupportedType);
    }
    Ok(())
}
