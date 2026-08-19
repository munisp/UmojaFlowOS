# Eventing runtime verification

Measured on **2026-08-19** against real local processes, not a substituted
broker or an in-memory event bus.

| Layer | Runtime | Endpoint / topic | What was verified |
|---|---|---|---|
| Kafka protocol | Redpanda 26.2.1, single-node development mode | `127.0.0.1:9092`, `payment.events` | Go native `franz-go` publisher produced and a native consumer read the exact immutable envelope. |
| Dapr | Dapr 1.18.3 | publisher sidecar `127.0.0.1:3500` | Go publisher → Dapr HTTP pub/sub → Redpanda → native consumer delivered a CloudEvent whose `data` held the original envelope unchanged. |
| Python consumer | FastAPI reporting service behind Dapr | app `127.0.0.1:8100`, subscriber sidecar `:3600` | Dapr loaded `payment-order-validated-local-regression`, delivered `POST /events/payment-order-validated`, and received HTTP 200. |
| Durable consumer handoff | Redis 7.0.15, database 15 reserved for regression | `umojaflowos:event-evidence:v1` | The delivered CloudEvent was atomically recorded in the Redis stream; `XLEN` was exactly 1 after the Go → Dapr → Kafka → Python route. |
| Fluvio | Fluvio 0.18.1 local standalone cluster | `compliance-events` | Rust 0.50.1 driver published and flushed a MANUAL_REVIEW policy-evidence event; bounded `fluvio consume` read the exact JSON, including `external_execution_authorized: false`. |

## The three producers and one consumer

| Language | Component | Responsibility | What it cannot do |
|---|---|---|---|
| Go | `internal/eventing/kafka.go` | Native Kafka publishing of payment-order validation evidence | It cannot publish to an arbitrary topic, and remote plaintext Kafka is refused. |
| Go | `internal/eventing/dapr.go` | Dapr sidecar publishing of the same envelope | It refuses remote plaintext, URL credentials, and path-shaped topics. |
| Rust | `src/eventing.rs` | Dapr and Fluvio publishing of policy-decision evidence | It rejects any event that claims execution authority. |
| Python | `service.py` | Dapr subscription consumer and Redis evidence ledger | It returns 503, so Dapr retries, until a real Redis ledger is verified. |

## Delivery semantics

Kafka/Dapr is at-least-once. The Python subscriber therefore never
acknowledges merely because it parsed an event. Its Lua transaction first sets a
hashed event-ID marker with `NX` and then `XADD`s the exact canonical CloudEvent
to `umojaflowos:event-evidence:v1`; a repeat delivery receives `SUCCESS` with
`delivery: duplicate` but creates no second stream row. A Redis error returns
503 and lets Dapr retry. Redis is an operational evidence and de-duplication
layer only; PostgreSQL remains canonical and TigerBeetle remains the
activation-gated double-entry accounting system.

## Development-only exceptions

The local regression uses Redpanda, Dapr and Fluvio bound to loopback without
TLS. Each application client rejects a plaintext remote endpoint and requires
an explicit `allow_insecure_loopback` configuration for the local exception.
The committed `infra/dapr/components/kafka-pubsub.yaml` retains TLS and secret
references for deployment; the local no-TLS component lives outside the
repository at `~/.dapr/components/kafka-local.yaml`.
