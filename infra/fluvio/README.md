# Fluvio alternative event-stream boundary

Fluvio is an alternative deployment target for the same versioned event envelopes used by the Kafka/Dapr boundary. It is disabled by default and must be configured with a private cluster endpoint and mTLS secret references. Do not enable both event-stream transports for the same production event path without a formal duplicate-delivery and ordering design.

The Go and Rust consumers must still verify envelope identity, version, correlation, idempotency, and policy state before any downstream projection is considered.
