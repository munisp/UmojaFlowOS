# Versioned contracts

All inter-service RPC and event contracts originate in this directory. The `domain.proto` package contains only cross-service domain data. A service must not import another service’s private persistence model. Contract changes are additive by default and must include compatibility tests before merging.
