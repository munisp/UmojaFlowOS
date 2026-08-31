# Yellow Card Multirail Integration

## Scope

UmojaFlowOS treats Yellow Card as a provider rail behind the normalized `multirail.Rail` contract. The adapter preserves the provider-generated sequence identifier as the idempotency key, keeps provider responses provisional, and maps ambiguous outcomes to `unknown` rather than guessing that no business effect occurred.

Yellow Card’s current public documentation identifies `POST /business/send` as the Send submission endpoint and documents lookup by sequence identifier through `GET /business/payments/sequence-id/{id}`.[^1] The adapter uses those two operations only. The lookup operation is read-only and is used after a submission transport failure before any fallback decision.

## Go composition

The production composition boundary is:

```go
handler, err := provider.NewCoordinatedYellowCardExecutionHandler(
    yellowCardClient,
    approvalSecret,
    multirail.NewCoordinator(),
    secondaryRail,
    postgresUnknownStateStore,
    time.Now,
    5*time.Minute,
    64*1024,
)
```

The constructor fails closed unless the secondary rail and durable UNKNOWN queue are both present. The HTTP handler still validates the deployment-managed approval HMAC before decoding or submitting a Send. Once the request is authenticated, it creates a normalized intent with the Yellow Card `sequenceId`, invokes the coordinator, and enqueues only `ErrUnknownOutcome` results.

The handler does not convert a provider HTTP 2xx response into settlement finality. It continues to return `finality_state: "provider_pending"`; independent provider evidence, webhook evidence, and ledger reconciliation remain separate controls. Yellow Card’s documentation describes a Send as awaiting approval and documents finite quote and payment-expiry windows, so the platform does not treat submission acceptance as completed settlement.[^2]

## Status mapping

| Yellow Card status family | Normalized state | Automatic fallback | Rationale |
|---|---|---:|---|
| `complete`, `completed`, `settled`, `success` | `settled` | No | A provider effect is indicated; reconciliation still does not grant settlement authority. |
| `created`, `accepted`, `processing`, `pending`, `awaiting_approval` | `pending` | No | The provider request remains provisional. |
| `expired`, `cancelled`, `canceled`, `rejected` | `failed` plus `safe_to_retry=true` | Only through the coordinator | These are treated as explicit non-execution classifications by the adapter. The contracting entity must validate this mapping during certification. |
| Generic `failed`, `declined`, `refunded`, or an unrecognized value | `unknown` | No | A generic failure does not prove absence of business effect. |

The Python, Rust, and TypeScript normalization functions mirror this table. The status mapping is intentionally conservative and must be verified against the contracting entity’s sandbox and production status catalog before activation.

## PostgreSQL-backed UNKNOWN persistence

`PostgresUnknownStateStore` uses `database/sql` and is driver-neutral. It binds the original intent payload to a SHA-256 digest, inserts the UNKNOWN record exactly once by idempotency key, atomically claims due records with a lease token, and records terminal decisions transactionally before resolving the queue row. The migration pair `0053_provider_unknown_reconciliation.sql` and `0054_unknown_reconciliation_payload_binding.sql` provides the queue, immutable decision table, terminal uniqueness index, payload binding, and lease columns.

A production deployment must supply an open-source PostgreSQL driver at process composition time, configure connection-pool limits and statement timeouts, and run the migrations before enabling coordinated execution. Existing rows from migration 0053 without trusted payload evidence intentionally cause migration 0054 to fail; they require an evidence-backed backfill rather than a synthetic default.

## Safety boundary

The reconciliation worker has no secondary-rail parameter and no write-capable provider method. It only performs a read-only lookup and records evidence. A `confirmed_non_submission` decision therefore remains an evidence result, not an execution command. Any later retry must pass through a separately authorized workflow with its own policy decision, idempotency binding, and audit record.

[^1]: [Yellow Card Lookup Send by sequenceId](https://docs.yellowcard.engineering/reference/lookup-payment-by-sequenceid.md) and [Submit Send Request](https://docs.yellowcard.engineering/reference/submit-payment.md).
[^2]: [Yellow Card Submit Send Request](https://docs.yellowcard.engineering/reference/submit-payment.md).
