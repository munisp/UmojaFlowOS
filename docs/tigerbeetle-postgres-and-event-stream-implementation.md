# TigerBeetle, PostgreSQL, and Fail-Closed Event Streams

## Ledger responsibility split

TigerBeetle remains the monetary double-entry authority. PostgreSQL is the control-plane and attributable projection store. A PostgreSQL row cannot create a monetary transfer; it can only represent a confirmed TigerBeetle fact after the configured projection sink accepts it.

## Go: double-entry command model

`services/payment-engine/internal/ledger/topology.go` defines the account and transfer command shapes. A transfer contains a debit account, credit account, positive amount, and currency. The `Client` interface exposes `CreateAccounts` and `CreateTransfers`; the default `DisabledClient` returns `tigerbeetle cluster is not configured` for either call. `ClusterConfig.Validate` rejects a zero cluster ID, missing addresses, blank addresses, or non-TLS transport before a real client may be installed.

```go
type Transfer struct {
    ID uint64; DebitAccountID uint64; CreditAccountID uint64
    Amount uint64; Currency string; PendingID uint64
}

type Client interface {
    CreateAccounts(context.Context, []Account) error
    CreateTransfers(context.Context, []Transfer) error
}
```

## Go: confirmed transfer projection bridge

`services/payment-engine/internal/ledger/projection.go` only accepts a complete confirmed-transfer fact and delegates it to a separately configured projection sink.

```go
func ProjectConfirmedTransfer(ctx context.Context, sink ProjectionSink, fact PostedTransferFact) error {
    if fact.TransferID == 0 || fact.CorrelationID == "" || fact.Currency == "" || fact.Amount == 0 || fact.PostedAt.IsZero() {
        return errors.New("complete confirmed tigerbeetle transfer evidence is required for projection")
    }
    if sink == nil { return errors.New("postgres projection sink is not configured") }
    return sink.ProjectPostedTransfer(ctx, fact)
}
```

The default `DisabledProjectionSink` rejects every call. This prevents PostgreSQL from representing a transfer before TigerBeetle confirmation and reconciliation are configured.

## Rust: balanced double-entry validation

`services/ledger-gateway/src/lib.rs` evaluates every posting set currency-by-currency. It rejects an empty set, blank account/currency, negative debit or credit amounts, and any non-zero per-currency net balance.

```rust
*balances.entry(&posting.currency).or_default() +=
    posting.debit_minor - posting.credit_minor;
for (currency, net_minor) in balances {
    if net_minor != 0 {
        return Err(LedgerError::Unbalanced { currency: currency.to_owned(), net_minor });
    }
}
```

## Rust: missing Kafka/Dapr input is fail-closed

`services/risk-compliance-core/src/lib.rs` now evaluates transport availability before normal policy allow logic.

```rust
pub fn evaluate_event_stream_input(input: &PolicyInput, stream_state: EventStreamState) -> PolicyResult {
    if stream_state == EventStreamState::InputUnavailable {
        return PolicyResult {
            decision: Decision::Block,
            reason_codes: vec!["INPUT_UNAVAILABLE_EVENT_STREAM".to_string()],
        };
    }
    evaluate(input)
}
```

The `InputUnavailable` state covers absent, disabled, or unverified Kafka/Dapr streams. The result is a **block**, not an inferred allow or retry-as-success. The associated `PolicyDecisionEvent` then always sets `external_execution_authorized: false`, including for an ordinary `ALLOW` policy decision.

`services/ledger-gateway/src/eventing.rs` separately rejects malformed or unsupported Dapr payment envelopes before a ledger projection is considered: missing identity returns `MissingIdentity`; unsupported event type or version returns `UnsupportedType`; disabled consumers return `TransportDisabled`.

## Validation

The Go projection tests prove that an absent or disabled sink rejects projection. Rust tests prove that `InputUnavailable` blocks an otherwise allowable transaction and that an available stream delegates to the normal policy evaluator. The canonical multi-language quality gate passes at the implementation revision described in the task history.
