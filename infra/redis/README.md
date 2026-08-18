# Redis boundary

Redis is reserved for short-lived idempotency reservations, replay protection, and cacheable non-authoritative control data. PostgreSQL remains the source of truth for payments, compliance, reporting, and audit evidence; TigerBeetle remains the future double-entry posting system.

This configuration exposes no plaintext port, requires mutual TLS and a secret-managed password, disables dangerous administrative commands, and must not be deployed with the literal `${REDIS_PASSWORD}` placeholder. The Go idempotency boundary denies operations while Redis is unconfigured or unavailable.
