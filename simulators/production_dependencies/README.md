# Production dependency simulator

This service is a local and CI-only simulator for external production resources. It is not a ledger, identity provider, AML provider, payment provider, WORM store, SIEM, or regulator.

## Run

```bash
uvicorn simulators.production_dependencies.app:app --host 127.0.0.1 --port 8099
```

## Covered contracts

| Tier | Endpoint | Simulated contract |
| --- | --- | --- |
| P0 | `/.well-known/openid-configuration` | OIDC discovery and RS256 metadata |
| P0 | `/v1/edge/authorize` | Scope and revocation enforcement |
| P0 | `/v1/aml/screen` | Clear/hit screening decision with provider/list evidence |
| P0 | `/v1/ledger/transfers` | Single-currency transfer, idempotency, and mismatch rejection |
| P0 | `/v1/webhooks/provider` | Timestamp freshness, HMAC-SHA256, and replay protection |
| P1 | `/v1/workflows/start` | Durable-workflow-like idempotent start boundary |
| P1 | `/v1/events/publish` | Versioned event publication and duplicate identity rejection |
| P1 | `/v1/wazuh/incidents` | Allowlisted SoD incident ingestion and deduplication |
| P1 | `/v1/worm/attest` | Compliance retention and signature-attestation acceptance boundary |
| P2 | `/v1/lakehouse/bronze` | Redaction gate before immutable-style bronze append |
| P2 | `/v1/entity-resolution/resolve` | Thresholded field linkage and cluster construction |

The simulator uses in-memory state and test-only identities. It must not be pointed at live traffic, used as a production ledger, or cited as proof of CBN authorization, provider licensing, real AML coverage, WORM retention, or financial settlement.

## Production replacement gates

Each simulated endpoint must be replaced or backed by the corresponding approved deployment before activation:

- OIDC and edge: Keycloak, APISIX/open-appsec, TLS, realm/client/role configuration.
- AML: licensed screening source, list provenance, case-management workflow, SAR/STR controls.
- Ledger: persistent TigerBeetle cluster, account topology, PostgreSQL projection, reconciliation, fencing.
- Webhooks: licensed provider, secret-manager reference, CIDR policy, signed callback and settlement reconciliation.
- Workflow/events: Temporal, Dapr/Kafka or approved equivalent, ACLs, replay/dead-letter policy.
- Wazuh/WORM: real manager, OpenSearch retention, independent Object Lock bucket, detached signature key custody.
- Analytics: governed PostgreSQL extract, production Splink model, Delta/Parquet storage, lineage, privacy review.

No simulator result closes an external production gate. Every real replacement requires a separate staging test and attributable evidence.
