# Kafka/Dapr Event Boundary and TigerBeetle Ledger Boundary

## Current implementation scope

The implementation is intentionally **provider-independent and fail closed**. It defines the message and ledger command boundaries in code; it does not claim that Kafka, Dapr, or TigerBeetle is deployed, reachable, credentialed, or authorised for monetary operations.

## Go payment-engine event producer boundary

`services/payment-engine/internal/eventing/event.go` defines the versioned event envelope:

```go
type Envelope struct {
    EventID       string          `json:"event_id"`
    EventType     string          `json:"event_type"`
    SchemaVersion string          `json:"schema_version"`
    OccurredAt    time.Time       `json:"occurred_at"`
    CorrelationID string          `json:"correlation_id"`
    Payload       json.RawMessage `json:"payload"`
}
```

`NewOrderValidated` rejects missing event or correlation identifiers, serializes the typed payload, normalizes the timestamp to UTC, and fixes the event type to `umojaflowos.payment.order.validated.v1`. The event can be published through the interface below:

```go
type Publisher interface {
    Publish(context.Context, string, Envelope) error
}
```

This is deliberately transport-neutral. A Kafka adapter implements `Publish` by producing the serialized envelope to an ACL-controlled topic, while a Dapr adapter implements it by publishing the same envelope through Dapr’s configured pub/sub component. Neither adapter belongs inside payment domain logic.

Until an adapter is wired to a deployed broker/runtime, `DisabledPublisher.Publish` returns an error. The unit test proves both the traceability requirement and that disabled transport cannot emit an event.

## Rust ledger-gateway event consumer boundary

`services/ledger-gateway/src/eventing.rs` defines the identical semantic envelope and validates it before any ledger projection:

```rust
pub fn validate_payment_event(event: &EventEnvelope) -> Result<(), EventError> {
    if event.event_id.trim().is_empty() || event.correlation_id.trim().is_empty() {
        return Err(EventError::MissingIdentity);
    }
    if event.event_type != PAYMENT_ORDER_VALIDATED_V1 || event.schema_version != "v1" {
        return Err(EventError::UnsupportedType);
    }
    Ok(())
}
```

The `EventConsumer` trait is the integration point for a Kafka consumer or Dapr subscriber. It receives a topic and validated envelope, permitting an adapter to reject unrecognized types, wrong schema versions, duplicate event identities, or malformed payloads before invoking a ledger command.

## TigerBeetle account and double-entry transfer topology

`services/payment-engine/internal/ledger/topology.go` defines the minimum account and transfer command topology required by a concrete TigerBeetle adapter:

| Account kind | Purpose |
|---|---|
| `customer_safeguarded` | Customer-controlled safeguarded balance for a single currency and legal ownership context. |
| `settlement_asset` | Corridor/currency settlement asset position. |
| `provider_clearing` | Payable/receivable position against an approved provider. |
| `fee_revenue` | Platform fee entitlement; never mixed with customer principal. |

```go
type Transfer struct {
    ID uint64
    DebitAccountID uint64
    CreditAccountID uint64
    Amount uint64
    Currency string
    PendingID uint64
}
```

Each movement is represented as a single debit/credit transfer in one currency. `PendingID` is reserved for two-phase settlement flows: create a pending transfer after policy approval, post it only on verified provider settlement evidence, or void it on rejection/expiry. The existing Rust `validate_balanced` function independently rejects empty, missing-account, missing-currency, negative, and per-currency-unbalanced posting sets.

The Go `Client` interface is intentionally small:

```go
type Client interface {
    CreateAccounts(context.Context, []Account) error
    CreateTransfers(context.Context, []Transfer) error
}
```

A production `TigerBeetleClient` adapter will translate these commands to the official TigerBeetle Go client only after a persistent cluster, account/transfer topology, TLS/network controls, and authorised ledger-operating model are approved. Currently `DisabledClient` returns `tigerbeetle cluster is not configured`, and a unit test proves that a transfer cannot silently proceed.

## Activation sequence

1. Deploy Kafka or a Dapr pub/sub component, define ACL-controlled topics, retention, replay, dead-letter, and encryption controls.
2. Deploy Dapr sidecars or a direct Kafka adapter with mutual TLS and service identity.
3. Deploy TigerBeetle with persistent replicas, configured cluster identity, backed-up storage, and approved account topology.
4. Register adapters through secret-managed configuration; do not embed broker endpoints, credentials, or ledger cluster addresses in source.
5. Only then enable consumer-driven ledger projections and pending/post/void transfer workflows after provider policy gates and human approval evidence are available.
