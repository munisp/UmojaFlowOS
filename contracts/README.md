# Versioned contracts

All inter-service RPC and event contracts originate in this directory. The `domain.proto` package contains only cross-service domain data. A service must not import another service’s private persistence model. Contract changes are additive by default and must include compatibility tests before merging.

The v1 contract carries the payment-validation, non-executable compliance-decision, and fail-closed ledger-command envelopes used across the Go payment engine and Rust risk/ledger boundaries. `external_execution_authorized` and `tigerbeetle_cluster_configured` are explicit gates; their presence never authorizes provider execution by itself.
