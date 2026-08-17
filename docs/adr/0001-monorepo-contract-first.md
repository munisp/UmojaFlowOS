# ADR 0001: Contract-first monorepo with production PostgreSQL and a separate monetary ledger

**Status:** Accepted for implementation.

UmojaFlowOS uses one GitHub monorepo because payment orchestration, risk, ledger, reporting, infrastructure, and interface changes require atomic contract review. Cross-language boundaries are versioned Protobuf and JSON Schema contracts. Production operational metadata is PostgreSQL. Monetary truth remains a dedicated TigerBeetle deployment behind the Rust ledger gateway. The managed TypeScript dashboard database is not selected as the production data store.

The decision prevents hidden breaking changes, reduces drift between corridor policy and execution, and enables a single auditable release provenance chain. It does not approve production deployment; deployment remains conditional on the selected target environment, regulated counterparty evidence, credentials, and counsel-approved activation.
